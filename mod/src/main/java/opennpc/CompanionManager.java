package opennpc;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import net.minecraft.network.chat.Component;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.damagesource.DamageSource;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EntitySpawnReason;
import net.minecraft.world.level.portal.TeleportTransition;
import net.minecraft.world.level.storage.LevelResource;
import net.minecraft.world.phys.Vec3;
import opennpc.brain.Brain;
import opennpc.entity.CompanionEntity;
import org.jspecify.annotations.Nullable;

/**
 * One companion per world: who she belongs to, keeping her in the world (she shows up when the owner joins, comes back
 * a little after dying, follows through portals), the AI link, and what the owner types in chat.
 * Main thread only, except where noted.
 */
public final class CompanionManager {
	private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();

	/** What this world remembers (opennpc.json in the world folder). */
	static final class State {
		String owner = "";
		String ownerName = "";
		String companion = "";
		/** Her last known mode, so a companion told to stay somewhere far away is not brought back. */
		String mode = "FOLLOW";
	}

	private final MinecraftServer server;
	private final Path configFile;
	private final Path stateFile;
	private NpcConfig cfg;
	private State state = new State();
	private Brain brain;
	private final CompanionBody body;
	private @Nullable CompanionEntity cached;
	private int lookIn = -1;          // ticks until it checks she is in the world
	private int respawnIn = -1;
	private int freeTicks = 0;
	private int missing = 0;          // checks in a row (every 10 s) that she wasn't in the loaded world
	private long lastHurtLine = 0;

	public CompanionManager(MinecraftServer server, Path configFile) {
		this.server = server;
		this.configFile = configFile;
		this.stateFile = server.getWorldPath(LevelResource.ROOT).resolve("opennpc.json");
		this.cfg = NpcConfig.load(configFile);
		try {
			if (Files.exists(stateFile)) {
				State s = GSON.fromJson(Files.readString(stateFile, StandardCharsets.UTF_8), State.class);
				if (s != null) state = s;
			}
		} catch (Exception e) {
			OpenNpc.LOG.warn("Open NPC: {} could not be read: {}", stateFile, e.getMessage());
		}
		this.body = new CompanionBody(this::companion, this::owner, () -> cfg.name, () -> {
			ServerPlayer o = owner();
			return o != null ? o.getGameProfile().name() : state.ownerName;
		}, this::say, this::summon);
		this.body.onCommand = () -> freeTicks = 0;
		this.body.afterCommand = c -> { String m = c.mode() == CompanionEntity.Mode.STAY ? "STAY" : "FOLLOW"; if (!m.equals(state.mode)) { state.mode = m; saveState(); } };
		this.brain = newBrain();
	}

	private Brain newBrain() {
		Brain b = new Brain(body, server, cfg.ai.url, cfg.key(), cfg.ai.model, cfg.speakInChat, line -> OpenNpc.LOG.info("[Open NPC] [ai] {}", line));
		OpenNpc.LOG.info("[Open NPC] {} asks the AI at {}", cfg.name, b.url());
		return b;
	}

	public void start() {
		brain.start();
		if (!server.getPlayerList().getPlayers().isEmpty()) lookIn = 60;
	}

	public void stop() {
		brain.stop();
		saveState();
	}

	public NpcConfig config() { return cfg; }
	public Brain brain() { return brain; }
	public CompanionBody body() { return body; }

	/** Reads the settings again and restarts the AI link. */
	public void reload() {
		brain.stop();
		cfg = NpcConfig.load(configFile);
		brain = newBrain();
		brain.start();
		CompanionEntity c = companion();
		if (c != null) apply(c);
	}

	public void rename(String name) {
		cfg.name = NpcConfig.cleanName(name);
		cfg.save(configFile);
		CompanionEntity c = companion();
		if (c != null) apply(c);
	}

	public void setGap(double gap) {
		cfg.followGap = Math.max(2, Math.min(12, gap));
		cfg.save(configFile);
		CompanionEntity c = companion();
		if (c != null) c.followGap = cfg.followGap;
	}

	// ---------------------------------------------------------------- the owner

	public @Nullable ServerPlayer owner() {
		if (!cfg.owner.isBlank()) {
			ServerPlayer p = server.getPlayerList().getPlayerByName(cfg.owner.trim());
			if (p != null) return p;
		}
		if (state.owner.isEmpty()) return null;
		try { return server.getPlayerList().getPlayer(UUID.fromString(state.owner)); } catch (IllegalArgumentException e) { return null; }
	}

	public boolean isOwner(ServerPlayer p) {
		if (!cfg.owner.isBlank()) return p.getGameProfile().name().equalsIgnoreCase(cfg.owner.trim());
		return state.owner.equals(p.getUUID().toString());
	}

	/** A player joined: the first one becomes her owner (when no owner is set); she shows up a moment later. */
	public void joined(ServerPlayer p) {
		if (!OpenNpc.autoCompanion) return;
		if (cfg.owner.isBlank() && state.owner.isEmpty()) {
			state.owner = p.getUUID().toString();
			state.ownerName = p.getGameProfile().name();
			saveState();
		}
		if (isOwner(p)) {
			if (!state.ownerName.equals(p.getGameProfile().name())) { state.ownerName = p.getGameProfile().name(); saveState(); }
			lookIn = 100;   // (her chunk loads with the player's; give it a few seconds before deciding she isn't there)
		}
	}

	/** The owner typed in chat. */
	public void chat(ServerPlayer p, String text) {
		if (!isOwner(p) || text == null || text.isBlank()) return;
		freeTicks = 0;
		brain.typed(text);
	}

	// ---------------------------------------------------------------- her, in the world

	public @Nullable CompanionEntity companion() {
		if (cached != null && cached.isAlive() && !cached.isRemoved()) return cached;
		cached = null;
		if (state.companion.isEmpty()) return null;
		UUID id;
		try { id = UUID.fromString(state.companion); } catch (IllegalArgumentException e) { return null; }
		for (ServerLevel level : server.getAllLevels()) {
			Entity e = level.getEntity(id);
			if (e instanceof CompanionEntity c && c.isAlive()) return cached = c;
		}
		return null;
	}

	/** A companion was loaded into a level: keep her if she is the one this world knows, else she is an old copy. */
	public void loaded(CompanionEntity c) {
		if (state.companion.isEmpty()) {
			state.companion = c.getUUID().toString();
			saveState();
		} else if (!state.companion.equals(c.getUUID().toString())) {
			if (!OpenNpc.autoCompanion) return;   // (tests make their own)
			c.discard();
			return;
		}
		cached = c;
		apply(c);
	}

	private void apply(CompanionEntity c) {
		c.setName(cfg.name);
		c.followGap = cfg.followGap;
		if (c.ownerId() == null && !state.owner.isEmpty()) {
			try { c.setOwner(UUID.fromString(state.owner)); } catch (IllegalArgumentException ignored) {}
		}
		ServerPlayer o = owner();
		if (o != null && !cfg.owner.isBlank()) c.setOwner(o.getUUID());
	}

	/** Puts her in the world near the owner (a few steps behind them, so she walks up). */
	public @Nullable CompanionEntity summon(ServerPlayer owner) {
		CompanionEntity old = companion();
		ServerLevel level = (ServerLevel) owner.level();
		if (old != null) {
			if (old.level() == level) {
				old.teleportNear(level, owner, 3);
				return old;
			}
			old.discard();
		}
		CompanionEntity c = OpenNpc.COMPANION.create(level, EntitySpawnReason.MOB_SUMMONED);
		if (c == null) return null;
		c.setOwner(owner.getUUID());
		c.snapTo(owner.getX(), owner.getY(), owner.getZ(), owner.getYRot(), 0);
		c.setName(cfg.name);
		c.followGap = cfg.followGap;
		if (!c.teleportNear(level, owner, cfg.followGap + 3) && !c.teleportNear(level, owner, 2)) {
			c.snapTo(owner.getX(), owner.getY(), owner.getZ(), owner.getYRot(), 0);
		}
		state.companion = c.getUUID().toString();
		if (state.owner.isEmpty()) { state.owner = owner.getUUID().toString(); state.ownerName = owner.getGameProfile().name(); }
		saveState();
		level.addFreshEntity(c);
		cached = c;
		return c;
	}

	/** The owner went to another dimension: she goes along. */
	public void bringToOwner(CompanionEntity c, ServerPlayer owner) {
		ServerLevel to = (ServerLevel) owner.level();
		Vec3 p = owner.position();
		Entity moved = c.teleport(new TeleportTransition(to, p, Vec3.ZERO, owner.getYRot(), 0, TeleportTransition.DO_NOTHING));
		if (moved instanceof CompanionEntity nc) {
			cached = nc;
			state.companion = nc.getUUID().toString();
			saveState();
			nc.teleportNear(to, owner, 3);
		}
	}

	public void ownerChangedLevel(ServerPlayer p) {
		if (!isOwner(p)) return;
		CompanionEntity c = companion();
		if (c != null && c.mode() != CompanionEntity.Mode.STAY && c.level() != p.level()) bringToOwner(c, p);
	}

	// ---------------------------------------------------------------- every tick

	public void tick() {
		brain.tick();
		ServerPlayer o = owner();
		if (o == null || !OpenNpc.autoCompanion) return;
		if (respawnIn > 0 && --respawnIn == 0) {
			if (summon(o) != null) event("companion_revived", Map.of(), false);
		}
		if (lookIn > 0 && --lookIn == 0 && respawnIn <= 0) {
			CompanionEntity c = companion();
			if (c == null) {
				boolean first = state.companion.isEmpty();
				if (summon(o) != null && first) event("companion_joined", Map.of(), false);
			}
		}
		CompanionEntity c = companion();
		// every 10 s: she is with the owner, unless she was told to stay (an owner who died and came back far away, or
		// went somewhere her ground stopped loading, finds her walking up a moment later)
		if (server.getTickCount() % 200 == 0 && lookIn <= 0 && respawnIn <= 0) {
			if (c != null) {
				missing = 0;
				if (!c.mode().name().equals(state.mode)) { state.mode = c.mode() == CompanionEntity.Mode.STAY ? "STAY" : "FOLLOW"; saveState(); }
			} else if (!"STAY".equals(state.mode) && !state.companion.isEmpty() && ++missing >= 2) {
				missing = 0;
				summon(o);
			}
		}
		if (c != null && c.mode() == CompanionEntity.Mode.FOLLOW && cfg.freeTimeMinutes > 0 && !brain.busy()) {
			if (++freeTicks >= cfg.freeTimeMinutes * 1200) {
				freeTicks = 0;
				Map<String, String> d = new LinkedHashMap<>();
				d.put("time", c.level().isBrightOutside() ? "day" : "night");
				event("free_time", d, false);
			}
		} else freeTicks = 0;
	}

	// ---------------------------------------------------------------- events, in plain words for the AI

	public void event(String event, Map<String, String> data, boolean high) {
		brain.event(event, data, high);
	}

	public void hurt(CompanionEntity c, DamageSource source) {
		long now = System.currentTimeMillis();
		if (now - lastHurtLine < 10000) return;
		lastHurtLine = now;
		Map<String, String> d = new LinkedHashMap<>();
		d.put("health", String.valueOf(Math.round(c.getHealth())));
		Entity by = source.getEntity();
		if (by != null) d.put("cause", by.getType().getDescription().getString().toLowerCase());
		event("companion_hurt", d, c.getHealth() < 8);
	}

	public void died(CompanionEntity c, DamageSource source) {
		if (!c.getUUID().toString().equals(state.companion)) return;
		cached = null;
		event("companion_downed", Map.of("cause", source.getLocalizedDeathMessage(c).getString()), false);
		respawnIn = 200;
	}

	public void ownerDied(ServerPlayer p, DamageSource source) {
		if (!isOwner(p)) return;
		event("player_died", Map.of("cause", source.getLocalizedDeathMessage(p).getString()), false);
	}

	// ---------------------------------------------------------------- chat and saving

	/** Her words in the game chat, the way a player's look. */
	public void say(String text) {
		server.getPlayerList().broadcastSystemMessage(Component.translatable("chat.type.text", Component.literal(cfg.name), Component.literal(text)), false);
	}

	private void saveState() {
		try {
			Files.writeString(stateFile, GSON.toJson(state), StandardCharsets.UTF_8);
		} catch (Exception e) {
			OpenNpc.LOG.warn("Open NPC: could not write {}: {}", stateFile, e.getMessage());
		}
	}
}
