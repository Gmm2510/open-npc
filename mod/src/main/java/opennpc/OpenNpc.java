package opennpc;

import com.mojang.brigadier.CommandDispatcher;
import com.mojang.brigadier.arguments.DoubleArgumentType;
import com.mojang.brigadier.arguments.StringArgumentType;
import com.mojang.brigadier.context.CommandContext;
import java.nio.file.Path;
import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.fabricmc.fabric.api.entity.event.v1.ServerEntityLevelChangeEvents;
import net.fabricmc.fabric.api.entity.event.v1.ServerLivingEntityEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerEntityEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.fabricmc.fabric.api.message.v1.ServerMessageEvents;
import net.fabricmc.fabric.api.networking.v1.ServerPlayConnectionEvents;
import net.fabricmc.fabric.api.object.builder.v1.entity.FabricDefaultAttributeRegistry;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.core.Registry;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.Identifier;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.MobCategory;
import opennpc.entity.CompanionEntity;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Open NPC: an AI companion who lives in any Minecraft world. She follows you, comes when called and stays when told,
 * and asks an AI of your choice what to do.
 */
public class OpenNpc implements ModInitializer {
	public static final String ID = "opennpc";
	public static final Logger LOG = LoggerFactory.getLogger("Open NPC");

	public static final ResourceKey<EntityType<?>> COMPANION_KEY = ResourceKey.create(Registries.ENTITY_TYPE, Identifier.fromNamespaceAndPath(ID, "companion"));
	public static final EntityType<CompanionEntity> COMPANION = Registry.register(BuiltInRegistries.ENTITY_TYPE, COMPANION_KEY,
		EntityType.Builder.<CompanionEntity>of(CompanionEntity::new, MobCategory.MISC)
			.sized(0.6F, 1.8F)
			.eyeHeight(1.62F)
			.clientTrackingRange(10)
			.noLootTable()
			.build(COMPANION_KEY));

	/** Off in the automatic tests, which make their own companions. */
	public static boolean autoCompanion = true;

	private static @Nullable CompanionManager manager;

	public static @Nullable CompanionManager manager() { return manager; }

	public static Path configFile() {
		return FabricLoader.getInstance().getConfigDir().resolve("opennpc.json");
	}

	@Override
	public void onInitialize() {
		FabricDefaultAttributeRegistry.register(COMPANION, CompanionEntity.createAttributes());

		ServerLifecycleEvents.SERVER_STARTED.register(server -> {
			manager = new CompanionManager(server, configFile());
			manager.start();
		});
		ServerLifecycleEvents.SERVER_STOPPING.register(server -> {
			if (manager != null) manager.stop();
			manager = null;
		});
		ServerTickEvents.END_SERVER_TICK.register(server -> { if (manager != null) manager.tick(); });
		ServerPlayConnectionEvents.JOIN.register((handler, sender, server) -> { if (manager != null) manager.joined(handler.player); });
		ServerMessageEvents.CHAT_MESSAGE.register((message, sender, params) -> { if (manager != null) manager.chat(sender, message.signedContent()); });
		ServerEntityEvents.ENTITY_LOAD.register((entity, level) -> { if (manager != null && entity instanceof CompanionEntity c) manager.loaded(c); });
		ServerEntityLevelChangeEvents.AFTER_PLAYER_CHANGE_LEVEL.register((player, from, to) -> { if (manager != null) manager.ownerChangedLevel(player); });
		ServerLivingEntityEvents.AFTER_DEATH.register((entity, source) -> { if (manager != null && entity instanceof ServerPlayer p) manager.ownerDied(p, source); });
		CommandRegistrationCallback.EVENT.register((dispatcher, access, env) -> commands(dispatcher));
		LOG.info("Open NPC is ready");
	}

	// ---------------------------------------------------------------- /opennpc

	private static void commands(CommandDispatcher<CommandSourceStack> d) {
		d.register(Commands.literal("opennpc")
			.executes(OpenNpc::status)
			.then(Commands.literal("come").executes(c -> act(c, "come")))
			.then(Commands.literal("follow").executes(c -> act(c, "follow")))
			.then(Commands.literal("stay").executes(c -> act(c, "stay")))
			.then(Commands.literal("wave").executes(c -> act(c, "emote")))
			.then(Commands.literal("summon").executes(OpenNpc::summon))
			.then(Commands.literal("reload").executes(OpenNpc::reload))
			.then(Commands.literal("name").then(Commands.argument("name", StringArgumentType.greedyString()).executes(OpenNpc::rename)))
			.then(Commands.literal("gap").then(Commands.argument("blocks", DoubleArgumentType.doubleArg(2, 12)).executes(OpenNpc::gap))));
	}

	/** Only her owner (or the server console) can tell her what to do with commands. */
	private static @Nullable CompanionManager allowed(CommandContext<CommandSourceStack> c) {
		CompanionManager m = manager;
		if (m == null) { c.getSource().sendFailure(Component.literal("Open NPC isn't running.")); return null; }
		ServerPlayer p = c.getSource().getPlayer();
		if (p != null && m.owner() != null && !m.isOwner(p)) {
			c.getSource().sendFailure(Component.literal(m.config().name + " listens to " + m.owner().getGameProfile().name() + "."));
			return null;
		}
		return m;
	}

	private static int status(CommandContext<CommandSourceStack> c) {
		CompanionManager m = manager;
		if (m == null) { c.getSource().sendFailure(Component.literal("Open NPC isn't running.")); return 0; }
		CompanionEntity e = m.companion();
		Boolean door = m.brain().waitDoor();
		String line = m.config().name + ": " + (e == null ? "not in the world" : e.doing())
			+ ". AI: " + m.brain().url() + (door == null ? "" : door ? " (a voice app with the wait door: her words aren't typed in chat)" : "")
			+ ". Questions asked: " + m.brain().asks() + ".";
		c.getSource().sendSuccess(() -> Component.literal(line), false);
		return 1;
	}

	private static int act(CommandContext<CommandSourceStack> c, String action) {
		CompanionManager m = allowed(c);
		if (m == null) return 0;
		var r = m.body().command(action, new com.google.gson.JsonObject(), true);
		if (!r.ok()) { c.getSource().sendFailure(Component.literal(m.config().name + " can't right now (" + r.reason().replace('_', ' ') + ").")); return 0; }
		return 1;
	}

	private static int summon(CommandContext<CommandSourceStack> c) {
		CompanionManager m = allowed(c);
		if (m == null) return 0;
		ServerPlayer p = c.getSource().getPlayer();
		if (p == null) p = m.owner();
		if (p == null) { c.getSource().sendFailure(Component.literal("Nobody to bring her to.")); return 0; }
		return m.summon(p) != null ? 1 : 0;
	}

	private static int reload(CommandContext<CommandSourceStack> c) {
		CompanionManager m = allowed(c);
		if (m == null) return 0;
		m.reload();
		c.getSource().sendSuccess(() -> Component.literal("Open NPC settings read again from " + configFile()), false);
		return 1;
	}

	private static int rename(CommandContext<CommandSourceStack> c) {
		CompanionManager m = allowed(c);
		if (m == null) return 0;
		m.rename(StringArgumentType.getString(c, "name"));
		c.getSource().sendSuccess(() -> Component.literal("Her name is now " + m.config().name + "."), false);
		return 1;
	}

	private static int gap(CommandContext<CommandSourceStack> c) {
		CompanionManager m = allowed(c);
		if (m == null) return 0;
		m.setGap(DoubleArgumentType.getDouble(c, "blocks"));
		c.getSource().sendSuccess(() -> Component.literal(m.config().name + " now keeps about " + Math.round(m.config().followGap) + " blocks from you."), false);
		return 1;
	}
}
