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
