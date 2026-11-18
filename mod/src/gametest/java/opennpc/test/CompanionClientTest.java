package opennpc.test;

import com.google.gson.JsonObject;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import net.fabricmc.fabric.api.client.gametest.v1.FabricClientGameTest;
import net.fabricmc.fabric.api.client.gametest.v1.context.ClientGameTestContext;
import net.fabricmc.fabric.api.client.gametest.v1.context.TestSingleplayerContext;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.core.BlockPos;
import net.minecraft.tags.ItemTags;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.client.CameraType;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.worldselection.WorldCreationUiState;
import net.minecraft.world.Difficulty;
import opennpc.OpenNpc;
import opennpc.entity.CompanionEntity;
import org.jspecify.annotations.Nullable;

/**
 * The real game: a new single-player world (in the test's own folder), Ana shows up on her own, follows, waits when told
 * in chat, comes when called in chat, all with a stand-in AI on this PC. Screenshots of each step.
 *
 *   gradlew runClientGameTest   (screenshots in build/run/clientGameTest/screenshots)
 */
public class CompanionClientTest implements FabricClientGameTest {
	private final List<String> notes = new ArrayList<>();

	@Override
	public void runTest(ClientGameTestContext ctx) {
		StandIn ai = StandIn.start(false, user -> {
			if (user.contains("typed to you: \"wait here\"")) return new StandIn.Reply("stay", "ok, I'll wait right here");
			if (user.contains("typed to you: \"come here\"")) return new StandIn.Reply("come", "coming!");
			if (user.contains("typed to you: \"get some wood\"")) return new StandIn.Reply("gather_wood", "sure, getting wood", n(4));
			if (user.contains("typed to you: \"mine some coal\"")) return new StandIn.Reply("mine_coal", "ok, I'll find some coal", n(1));
			return new StandIn.Reply(null, null);
		});
		writeConfig(ai.url());
		ctx.getInput().resizeWindow(1280, 720);

		// Fabric's test world: flat grassland, the same every time (so the pictures and the checks never depend on luck)
		try (TestSingleplayerContext sp = ctx.worldBuilder().adjustSettings(s -> {
			s.setGameMode(WorldCreationUiState.SelectedGameMode.SURVIVAL);
			s.setDifficulty(Difficulty.PEACEFUL);
			s.setAllowCommands(true);
		}).create()) {
			sp.getClientLevel().waitForChunksRender();
			sp.getServer().runCommand("time set 1000");
			sp.getServer().runCommand("weather clear");
			ctx.waitTicks(40);
			sp.getClientLevel().waitForChunksRender();

			// she shows up a few seconds after he joins, a few steps behind him, and walks up
			ctx.waitFor(mc -> ana(mc) != null, 1200);
			note(ctx, "she is in the world");
			ctx.waitFor(mc -> { CompanionEntity a = ana(mc); return a != null && a.distanceTo(mc.player) < 6 && a.getDeltaMovement().horizontalDistance() < 0.01; }, 600);
			ctx.waitTicks(20);
			ctx.runOnClient(mc -> mc.gui.getChat().clearMessages(false));
			faceAna(ctx);
			ctx.waitTicks(10);
			ctx.takeScreenshot("open-npc-1-she-walks-up");
			note(ctx, "walked up");

			// he walks off; she follows
			turnAwayFromAna(ctx);
			ctx.getInput().holdKeyFor(o -> o.keyUp, 70);
			ctx.waitTicks(30);
			faceAna(ctx);
			ctx.waitTicks(5);
			ctx.takeScreenshot("open-npc-2-she-follows");
			note(ctx, "after he walked off");

			// typed in chat: she waits
			ctx.runOnClient(mc -> mc.player.connection.sendChat("wait here"));
			waitServer(ctx, sp, CompanionEntity.Mode.STAY, 400);
			ctx.waitTicks(10);
			ctx.takeScreenshot("open-npc-3-asked-to-wait");
			turnAwayFromAna(ctx);
			ctx.getInput().holdKeyFor(o -> o.keyUp, 75);
			ctx.waitTicks(20);
			faceAna(ctx);
			ctx.waitTicks(5);
			ctx.takeScreenshot("open-npc-4-she-stays");
			note(ctx, "he walked away while she stays");

			// typed in chat: she comes
			ctx.runOnClient(mc -> mc.player.connection.sendChat("come here"));
			waitServer(ctx, sp, CompanionEntity.Mode.COME, 400);
			ctx.waitTicks(25);
			faceAna(ctx);
			ctx.takeScreenshot("open-npc-5-she-comes");
			waitServer(ctx, sp, CompanionEntity.Mode.FOLLOW, 600);
			ctx.waitTicks(20);
			faceAna(ctx);
			ctx.waitTicks(5);
			ctx.takeScreenshot("open-npc-6-she-came");
			note(ctx, "she came");

			// a look at both of them from behind
			ctx.runOnClient(mc -> mc.options.setCameraType(CameraType.THIRD_PERSON_BACK));
			ctx.waitTicks(10);
			ctx.takeScreenshot("open-npc-7-third-person");
			ctx.runOnClient(mc -> mc.options.setCameraType(CameraType.FIRST_PERSON));

			// if she dies she comes back near him a little later
			sp.getServer().runCommand("kill @e[type=opennpc:companion]");
			ctx.waitFor(mc -> ana(mc) == null, 100);
			note(ctx, "after she was knocked out");
			ctx.waitFor(mc -> ana(mc) != null, 600);
			note(ctx, "she came back");

			// ---- step 2, the jobs: two oak trees and a little rock with coal showing, a few steps from him
			int[] b = sp.getServer().computeOnServer(server -> {
				BlockPos p = server.getPlayerList().getPlayers().get(0).blockPosition();
				return new int[] {p.getX(), p.getY(), p.getZ()};
			});
			int x = b[0], y = b[1], z = b[2];
			sp.getServer().runCommand("place feature minecraft:oak " + (x + 7) + " " + y + " " + (z + 4));
			sp.getServer().runCommand("place feature minecraft:oak " + (x + 10) + " " + y + " " + (z - 5));
			sp.getServer().runCommand("fill " + (x - 7) + " " + y + " " + (z + 2) + " " + (x - 5) + " " + (y + 2) + " " + (z + 4) + " minecraft:stone");
			sp.getServer().runCommand("setblock " + (x - 5) + " " + (y + 1) + " " + (z + 3) + " minecraft:coal_ore");
			ctx.waitTicks(40);
			ctx.runOnClient(mc -> mc.gui.getChat().clearMessages(false));

			// typed in chat: she chops wood and brings it
			ctx.runOnClient(mc -> mc.player.connection.sendChat("get some wood"));
			waitJob(ctx, sp, "chopping", 400);
			waitServer(ctx, sp, a -> a.count(st -> st.is(ItemTags.LOGS)) >= 1, 1200, "a first log");
			ctx.waitTicks(15);
			faceAna(ctx);
			ctx.waitTicks(5);
			ctx.takeScreenshot("open-npc-8-she-chops-a-tree");
			waitServer(ctx, sp, a -> a.job() == null, 2400, "the wood job to end");
			ctx.waitTicks(40);
			faceAna(ctx);
			ctx.waitTicks(5);
			ctx.takeScreenshot("open-npc-9-she-hands-over-the-logs");
			note(ctx, "wood: he holds " + held(ctx, st -> st.is(ItemTags.LOGS)) + " logs");

			// typed in chat: coal. She has no pickaxe, so she chops wood, sets down a table, makes one, mines, brings it
			ctx.runOnClient(mc -> mc.player.connection.sendChat("mine some coal"));
			waitJob(ctx, sp, "mining", 400);
			waitServer(ctx, sp, CompanionClientTest::tableNear, 3000, "her crafting table");
			ctx.waitTicks(8);
			faceAna(ctx);
			ctx.waitTicks(4);
			ctx.takeScreenshot("open-npc-10-she-sets-down-a-table-and-crafts");
			waitServer(ctx, sp, a -> a.getMainHandItem().is(Items.WOODEN_PICKAXE), 3000, "her pickaxe in hand");
			ctx.waitTicks(20);
			faceAna(ctx);
			ctx.waitTicks(4);
			ctx.takeScreenshot("open-npc-11-she-mines-the-coal");
			waitServer(ctx, sp, a -> a.job() == null, 3000, "the coal job to end");
			ctx.waitTicks(40);
			faceAna(ctx);
			ctx.waitTicks(5);
			ctx.takeScreenshot("open-npc-12-she-hands-over-the-coal");
			note(ctx, "coal: he holds " + held(ctx, st -> st.is(Items.COAL)) + " coal");
			boolean tableLeft = sp.getServer().computeOnServer(server -> {
				CompanionEntity a = OpenNpc.manager().companion();
				return a != null && tableNear(a);
			});
			if (tableLeft) throw new AssertionError("she left her crafting table standing");
		}
		ai.close();
		OpenNpc.LOG.info("[client test] {}", String.join(" | ", notes));
	}

	private void note(ClientGameTestContext ctx, String what) {
		String line = ctx.computeOnClient(mc -> {
			CompanionEntity a = ana(mc);
			return what + ": " + (a == null ? "not seen" : String.format(java.util.Locale.ROOT, "%.1f blocks away", a.distanceTo(mc.player)));
		});
		notes.add(line);
		OpenNpc.LOG.info("[client test] {}", line);
	}

	private static void writeConfig(String url) {
		Path f = FabricLoader.getInstance().getConfigDir().resolve("opennpc.json");
		JsonObject ai = new JsonObject();
		ai.addProperty("url", url);
		ai.addProperty("key", "");
		ai.addProperty("model", "");
		JsonObject c = new JsonObject();
		c.addProperty("name", "Ana");
		c.addProperty("owner", "");
		c.addProperty("speakInChat", "auto");
		c.addProperty("followGap", 4);
		c.addProperty("freeTimeMinutes", 0);
		c.add("ai", ai);
		try {
			Files.createDirectories(f.getParent());
			Files.writeString(f, c.toString(), StandardCharsets.UTF_8);
		} catch (Exception e) {
			throw new RuntimeException(e);
		}
	}

	private static @Nullable CompanionEntity ana(Minecraft mc) {
		if (mc.level == null || mc.player == null) return null;
		List<CompanionEntity> l = mc.level.getEntitiesOfClass(CompanionEntity.class, mc.player.getBoundingBox().inflate(64));
		return l.isEmpty() ? null : l.get(0);
	}

	private static JsonObject n(int n) {
		JsonObject a = new JsonObject();
		a.addProperty("n", n);
		return a;
	}

	private static boolean tableNear(CompanionEntity a) {
		for (BlockPos p : BlockPos.betweenClosed(a.blockPosition().offset(-6, -2, -6), a.blockPosition().offset(6, 3, 6))) if (a.level().getBlockState(p).is(Blocks.CRAFTING_TABLE)) return true;
		return false;
	}

	private static int held(ClientGameTestContext ctx, java.util.function.Predicate<ItemStack> which) {
		return ctx.computeOnClient(mc -> {
			int n = 0;
			for (int i = 0; i < mc.player.getInventory().getContainerSize(); i++) if (which.test(mc.player.getInventory().getItem(i))) n += mc.player.getInventory().getItem(i).getCount();
			return n;
		});
	}

	/** Waits (from the test thread) until her job's name has this in it. */
	private static void waitJob(ClientGameTestContext ctx, TestSingleplayerContext sp, String word, int maxTicks) {
		waitServer(ctx, sp, a -> a.job() != null && a.job().label().contains(word), maxTicks, "a job with '" + word + "'");
	}

	/** Waits (from the test thread) until this is true of her on the server. */
	private static void waitServer(ClientGameTestContext ctx, TestSingleplayerContext sp, java.util.function.Predicate<CompanionEntity> ok, int maxTicks, String what) {
		for (int i = 0; i < maxTicks; i++) {
			boolean yes = sp.getServer().computeOnServer(server -> {
				CompanionEntity a = OpenNpc.manager() == null ? null : OpenNpc.manager().companion();
				return a != null && ok.test(a);
			});
			if (yes) return;
			ctx.waitTick();
		}
		String doing = sp.getServer().computeOnServer(server -> OpenNpc.manager() == null || OpenNpc.manager().companion() == null ? "not there" : OpenNpc.manager().companion().doing());
		throw new AssertionError("waited " + maxTicks + " ticks for " + what + "; she is " + doing);
	}

	/** Waits (from the test thread) until her mode on the server is this one. */
	private static void waitServer(ClientGameTestContext ctx, TestSingleplayerContext sp, CompanionEntity.Mode mode, int maxTicks) {
		for (int i = 0; i < maxTicks; i++) {
			String m = sp.getServer().computeOnServer(server -> {
				CompanionEntity a = OpenNpc.manager() == null ? null : OpenNpc.manager().companion();
				return a == null ? "" : a.mode().name();
			});
			if (m.equals(mode.name())) return;
			ctx.waitTick();
		}
		throw new AssertionError("she did not get to " + mode + " within " + maxTicks + " ticks");
	}

	private static void faceAna(ClientGameTestContext ctx) {
		float[] yp = ctx.computeOnClient(mc -> {
			CompanionEntity a = ana(mc);
			if (a == null) return new float[] {mc.player.getYRot(), 0};
			double dx = a.getX() - mc.player.getX(), dz = a.getZ() - mc.player.getZ();
			double dy = a.getEyeY() - 0.4 - mc.player.getEyeY();
			float yaw = (float) Math.toDegrees(Math.atan2(dz, dx)) - 90;
			float pitch = (float) -Math.toDegrees(Math.atan2(dy, Math.hypot(dx, dz)));
			return new float[] {yaw, pitch + 8};
		});
		ctx.getInput().lookAt(yp[0], yp[1]);
	}

	private static void turnAwayFromAna(ClientGameTestContext ctx) {
		float yaw = ctx.computeOnClient(mc -> {
			CompanionEntity a = ana(mc);
			if (a == null) return mc.player.getYRot();
			return (float) Math.toDegrees(Math.atan2(a.getZ() - mc.player.getZ(), a.getX() - mc.player.getX())) - 90 + 180;
		});
		ctx.getInput().lookAt(yaw, 5);
	}
}
