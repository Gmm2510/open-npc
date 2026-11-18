package opennpc;

import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;
import java.util.function.Function;
import java.util.function.Supplier;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.monster.Enemy;
import net.minecraft.world.level.Level;
import opennpc.brain.Brain;
import opennpc.entity.CompanionEntity;
import org.jspecify.annotations.Nullable;

/**
 * What the AI sees of the companion (her situation, what she can do) and what it can make her do.
 * Main thread only.
 */
public final class CompanionBody implements Brain.Body {
	/** What she can do now, in the order the AI sees them. More come with later steps (jobs, building, farming). */
	public static final Map<String, String> ACTIONS;
	static {
		Map<String, String> a = new LinkedHashMap<>();
		a.put("follow", "stay close to the owner (the default)");
		a.put("come", "walk over to the owner right now");
		a.put("stay", "wait right here until told to follow or come");
		a.put("emote", "a little wave and a hop");
		a.put("stop_task", "stop what you are doing and follow");
		ACTIONS = java.util.Collections.unmodifiableMap(a);
	}

	private final Supplier<@Nullable CompanionEntity> companion;
	private final Supplier<@Nullable ServerPlayer> owner;
	private final Supplier<String> name;
	private final Supplier<String> ownerName;
	private final Consumer<String> chat;
	private final Function<ServerPlayer, @Nullable CompanionEntity> summon;
	public Runnable onCommand = () -> {};

	public CompanionBody(Supplier<@Nullable CompanionEntity> companion, Supplier<@Nullable ServerPlayer> owner, Supplier<String> name,
		Supplier<String> ownerName, Consumer<String> chat, Function<ServerPlayer, @Nullable CompanionEntity> summon) {
		this.companion = companion;
		this.owner = owner;
		this.name = name;
		this.ownerName = ownerName;
		this.chat = chat;
		this.summon = summon;
	}

	@Override
	public String name() { return name.get(); }

	@Override
	public String owner() { return ownerName.get(); }

	@Override
	public Map<String, String> actions() { return ACTIONS; }

	@Override
	public Map<String, String> situation() {
		Map<String, String> s = new LinkedHashMap<>();
		CompanionEntity c = companion.get();
		if (c == null) {
			s.put("where you are", "not in the world right now");
			return s;
		}
		Level level = c.level();
		s.put("your health", Math.round(c.getHealth()) + "/" + Math.round(c.getMaxHealth()));
		s.put("time", level.isBrightOutside() ? "day" : "night");
		if (level.isThundering()) s.put("weather", "thunderstorm");
		else if (level.isRaining()) s.put("weather", "rain");
		ServerPlayer o = owner.get();
		String on = owner();
		if (o == null) s.put(on.isEmpty() ? "the player" : on, "not online");
		else if (o.level() != level) s.put("distance to " + (on.isEmpty() ? "the player" : on), "in another dimension");
		else s.put("distance to " + (on.isEmpty() ? "the player" : on), Math.round(c.distanceTo(o)) + " blocks");
		List<String> hostile = new ArrayList<>();
		for (LivingEntity e : level.getEntitiesOfClass(LivingEntity.class, c.getBoundingBox().inflate(16), e -> e instanceof Enemy && e.isAlive())) {
			if (hostile.size() >= 4) break;
			hostile.add(e.getType().getDescription().getString().toLowerCase());
		}
		if (!hostile.isEmpty()) s.put("hostile mobs nearby", String.join(", ", hostile));
		s.put("doing now", c.doing());
		s.put("your height (y)", String.valueOf(c.getBlockY()));
		if (level.dimension() == Level.NETHER) s.put("where you are", "the Nether");
		else if (level.dimension() == Level.END) s.put("where you are", "the End");
		return s;
	}

	@Override
	public Brain.Result command(String action, JsonObject args, boolean byPlayer) {
		onCommand.run();
		CompanionEntity c = companion.get();
		ServerPlayer o = owner.get();
		if (c == null) {
			if (o == null || !(action.equals("come") || action.equals("follow") || action.equals("stop_task"))) return Brain.Result.no("not_in_the_world");
			c = summon.apply(o);
			if (c == null) return Brain.Result.no("no_room_near_you");
		}
		switch (action) {
			case "follow", "stop_task" -> c.setMode(CompanionEntity.Mode.FOLLOW);
			case "come" -> c.setMode(CompanionEntity.Mode.COME);
			case "stay" -> c.setMode(CompanionEntity.Mode.STAY);
			case "emote" -> c.emote();
			default -> { return Brain.Result.no("unknown"); }
		}
		return Brain.Result.started();
	}

	@Override
	public void say(String text) {
		chat.accept(text);
	}

	/** True when the level the companion is in is this one (for tests and checks). */
	public boolean in(ServerLevel level) {
		CompanionEntity c = companion.get();
		return c != null && c.level() == level;
	}
}
