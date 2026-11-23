package opennpc.test;

import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import net.fabricmc.fabric.api.gametest.v1.GameTest;
import net.minecraft.core.BlockPos;
import net.minecraft.gametest.framework.GameTestHelper;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.util.Mth;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;
import opennpc.CompanionBody;
import opennpc.OpenNpc;
import opennpc.brain.Brain;
import opennpc.entity.CompanionEntity;

/**
 * The companion in a real (headless) Minecraft server: she spawns, follows, comes, stays, catches up, and an answer
 * from a stand-in AI moves her (typed in chat, and through the wait door). Each test runs in its own batch so the
 * companions of different tests never meet.
 *
 *   gradlew runGameTest   (also part of gradlew build)
 */
public class CompanionGameTests {
	static final double GAP = 4;

	/** One test's world: a 44 x 44 stone floor, an owner (a stand-in player), and Ana. */
	record Scene(GameTestHelper h, ServerLevel level, ServerPlayer owner, CompanionEntity ana) {
		void ownerAt(double x, double z) {
			Vec3 p = h.absoluteVec(new Vec3(x, 0, z));
			owner.snapTo(p.x, p.y, p.z, owner.getYRot(), 0);
			level.getChunkSource().move(owner);   // (the ground around a player keeps running, as in a real game)
		}

		void ownerFacing(float yRot) { owner.setYRot(yRot); owner.setYHeadRot(yRot); }

		double dist() { return ana.distanceTo(owner); }

		void done() {
			forceFloor(h, false);
			ana.discard();
			level.getServer().getPlayerList().remove(owner);
			h.succeed();
		}
	}

	static Scene scene(GameTestHelper h, double ownerX, double ownerZ, double anaX, double anaZ) {
		ServerLevel level = h.getLevel();
		// (no monsters wandering into tests that aren't about fighting; the fight test turns them back on)
		level.getServer().setDifficulty(net.minecraft.world.Difficulty.PEACEFUL, true);
		// leftovers from an earlier test go first
		for (Entity e : level.getEntities((Entity) null, new AABB(Vec3.atCenterOf(h.absolutePos(new BlockPos(-60, -10, -60))), Vec3.atCenterOf(h.absolutePos(new BlockPos(80, 20, 80)))), e -> e instanceof CompanionEntity)) e.discard();
		// (stand-in players an earlier test left behind could be in her way)
		for (ServerPlayer old : new ArrayList<>(level.getServer().getPlayerList().getPlayers())) {
			if (old.getGameProfile().name().equals("test-mock-player")) level.getServer().getPlayerList().remove(old);
		}
		for (int x = -16; x <= 27; x++) {
			for (int z = -16; z <= 27; z++) {
				h.setBlock(x, -1, z, Blocks.STONE);
				for (int y = 0; y <= 9; y++) h.setBlock(x, y, z, Blocks.AIR);   // (up past the test's barrier ceiling)
			}
		}
		forceFloor(h, true);
		@SuppressWarnings("removal")
		ServerPlayer owner = h.makeMockServerPlayerInLevel();
		CompanionEntity ana = h.spawn(OpenNpc.COMPANION, new Vec3(anaX, 0, anaZ));
		ana.setOwner(owner.getUUID());
		ana.setName("Ana");
		ana.followGap = GAP;
		Scene s = new Scene(h, level, owner, ana);
		s.ownerAt(ownerX, ownerZ);
		h.onEachTick(() -> {
			if (h.getTick() % 40 == 0 && !ana.isRemoved()) OpenNpc.LOG.info("[trace] t={} ana {} mode {} walking {} nav {} speed {} | owner {} online {} dist {}", h.getTick(), short3(ana.position()), ana.mode(), ana.isWalking(),
				ana.getNavigation().isDone() ? "done" : "going", fmt(ana.speedNow()), short3(owner.position()), ana.owner() != null, fmt(ana.distanceTo(owner)));
		});
		return s;
	}

	/** The test server only runs the game right around each test; keep the whole floor running like the ground near a player. */
	static void forceFloor(GameTestHelper h, boolean on) {
		BlockPos a = h.absolutePos(new BlockPos(-16, 0, -16)), b = h.absolutePos(new BlockPos(27, 0, 27));
		for (int cx = Math.min(a.getX(), b.getX()) >> 4; cx <= Math.max(a.getX(), b.getX()) >> 4; cx++)
			for (int cz = Math.min(a.getZ(), b.getZ()) >> 4; cz <= Math.max(a.getZ(), b.getZ()) >> 4; cz++)
				h.getLevel().setChunkForced(cx, cz, on);
		if (!on) return;
		// (a forced chunk only runs its entities once the chunks around it are loaded too, and those load in the background while
		// the test server races through its ticks. One run had her stand frozen just past a chunk border until the test timed
		// out, which fits a floor chunk that wasn't running yet. So the floor's chunks and two rings around them are loaded
		// here, before anything moves.)
		for (int cx = (Math.min(a.getX(), b.getX()) >> 4) - 2; cx <= (Math.max(a.getX(), b.getX()) >> 4) + 2; cx++)
			for (int cz = (Math.min(a.getZ(), b.getZ()) >> 4) - 2; cz <= (Math.max(a.getZ(), b.getZ()) >> 4) + 2; cz++)
				h.getLevel().getChunk(cx, cz);
	}

	static void check(GameTestHelper h, boolean ok, String what) {
		h.assertTrue(ok, what);
	}

	// ---------------------------------------------------------------- the body

	@GameTest(environment = "opennpc-test:solo_spawn", maxTicks = 100)
	public void spawns(GameTestHelper h) {
		Scene s = scene(h, 6, 6, 4, 4);
		h.runAfterDelay(40, () -> {
			check(h, s.ana.isAlive() && !s.ana.isRemoved(), "she is in the world");
			check(h, s.ana.getCustomName() != null && s.ana.getCustomName().getString().equals("Ana"), "she has her name");
			check(h, s.ana.requiresCustomPersistence() && !s.ana.removeWhenFarAway(10000), "she never despawns");
			check(h, s.owner.getUUID().equals(s.ana.ownerId()), "she knows her owner");
			check(h, s.ana.mode() == CompanionEntity.Mode.FOLLOW, "she starts by following");
			check(h, s.ana.position().distanceTo(h.absoluteVec(new Vec3(4, 0, 4))) < 0.8, "the owner is close, so she stays put (no shuffling)");
			s.done();
		});
	}

	@GameTest(environment = "opennpc-test:solo_follow", maxTicks = 300)
	public void follows_to_a_friendly_distance(GameTestHelper h) {
		Scene s = scene(h, 20, 20, 2, 2);
		s.ownerFacing(45);
		int[] still = {0};
		h.onEachTick(() -> {
			if (s.ana.isRemoved()) return;
			if (!s.ana.isWalking() && s.dist() <= GAP + 1.2) still[0]++;
			else still[0] = 0;
			if (still[0] >= 20) {
				check(h, s.dist() >= 2.0, "she stops at a friendly distance, not on top of him (" + fmt(s.dist()) + ")");
				OpenNpc.LOG.info("[test] follow: stopped {} blocks from the owner after {} ticks", fmt(s.dist()), h.getTick());
				s.done();
			}
		});
	}

	@GameTest(environment = "opennpc-test:solo_walk", maxTicks = 500)
	public void follows_a_walking_owner_naturally(GameTestHelper h) {
		Scene s = scene(h, 0, 0, -3, -2);
		// the owner walks 24 blocks across the floor at a normal walking pace (4.3 blocks a second), then stops
		double pace = 0.216;
		int walkTicks = (int) Math.ceil(24 / pace);
		double[] prev = {Double.NaN};
		float[] prevYaw = {Float.NaN};
		double[] worst = {0, 0, 0};      // biggest speed change in one tick, biggest turn in one tick, farthest behind
		int[] stopped = {0, 0};          // ticks standing still while he is far, longest such stretch
		List<Double> speeds = new ArrayList<>();
		Vec3[] last = {s.ana.position()};
		h.onEachTick(() -> {
			if (s.ana.isRemoved()) return;
			long t = h.getTick();
			if (t <= walkTicks) {
				double x = 0 + t * pace * 0.8, z = 0 + t * pace * 0.6;   // heading south-east
				s.ownerAt(x, z);
				s.ownerFacing((float) Math.toDegrees(Math.atan2(0.6, 0.8)) - 90);
			}
			Vec3 now = s.ana.position();
			double v = Math.hypot(now.x - last[0].x, now.z - last[0].z);
			last[0] = now;
			speeds.add(v);
			if (!Double.isNaN(prev[0])) worst[0] = Math.max(worst[0], Math.abs(v - prev[0]));
			prev[0] = v;
			if (s.ana.isWalking() && !Float.isNaN(prevYaw[0])) worst[1] = Math.max(worst[1], Math.abs(Mth.wrapDegrees(s.ana.getYRot() - prevYaw[0])));
			prevYaw[0] = s.ana.getYRot();
			worst[2] = Math.max(worst[2], s.dist());
			if (t <= walkTicks && s.dist() > GAP + 3 && v < 0.02) { stopped[0]++; stopped[1] = Math.max(stopped[1], stopped[0]); } else stopped[0] = 0;
			if (t > walkTicks + 20 && !s.ana.isWalking() && s.dist() <= GAP + 1.2) {
				double top = speeds.stream().mapToDouble(d -> d).max().orElse(0);
				OpenNpc.LOG.info("[test] walk: top speed {} b/s, biggest speed change in a tick {} b/s, biggest turn in a tick {} deg, farthest behind {}, longest stop while he walked {} ticks, ended {} from him",
					fmt(top * 20), fmt(worst[0] * 20), fmt(worst[1]), fmt(worst[2]), stopped[1], fmt(s.dist()));
				check(h, worst[2] < 12, "she keeps up (farthest behind " + fmt(worst[2]) + ")");
				check(h, stopped[1] <= 10, "she never stands still while he walks away (" + stopped[1] + " ticks)");
				check(h, worst[0] < 0.14, "her speed eases, no sudden stops or starts (" + fmt(worst[0] * 20) + " b/s in one tick)");
				check(h, worst[1] <= 31, "she turns smoothly, no snapping round (" + fmt(worst[1]) + " degrees in one tick)");
				check(h, top * 20 < 7.5, "she never moves faster than a running player (" + fmt(top * 20) + " b/s)");
				check(h, s.dist() >= 2.0, "she ends beside him, not on top of him");
				s.done();
			}
		});
	}

	@GameTest(environment = "opennpc-test:solo_run", maxTicks = 400)
	public void runs_to_catch_up_without_a_burst(GameTestHelper h) {
		// he stands 28 blocks off: far enough for her fastest run (and the game's own sprinting, which used to add 30% on top in one tick)
		Scene s = scene(h, 16, 16, -4, -4);
		double[] top = {0}, change = {0}, prev = {Double.NaN, 0};
		Vec3[] last = {s.ana.position()};
		h.onEachTick(() -> {
			if (s.ana.isRemoved()) return;
			Vec3 now = s.ana.position();
			double v = Math.hypot(now.x - last[0].x, now.z - last[0].z);
			last[0] = now;
			top[0] = Math.max(top[0], v);
			// (while she runs in, where the burst was: the start from standing and the stop on arriving are another matter)
			if (!Double.isNaN(prev[0]) && prev[0] > 0.05 && s.ana.speedNow() >= 1.0 && prev[1] >= 1.0 && s.dist() > GAP + 3) change[0] = Math.max(change[0], Math.abs(v - prev[0]));
			prev[0] = v;
			prev[1] = s.ana.speedNow();
			if (h.getTick() > 20 && !s.ana.isWalking() && s.dist() <= GAP + 1.2) {
				OpenNpc.LOG.info("[test] run: top speed {} b/s, biggest speed change in a tick while moving {} b/s, arrived after {} ticks", fmt(top[0] * 20), fmt(change[0] * 20), h.getTick());
				check(h, top[0] * 20 > 6.0, "she runs to catch up (" + fmt(top[0] * 20) + " b/s)");
				check(h, top[0] * 20 < 7.5, "she never moves faster than a running player (" + fmt(top[0] * 20) + " b/s)");
				// (4 blocks a second in one tick: a steady run already jumps up to about 2.8 on 26.3's test server; the old burst shows in her top speed)
				check(h, change[0] < 0.2, "her speed eases through the run, no lurch (" + fmt(change[0] * 20) + " b/s in one tick)");
				s.done();
			}
		});
	}

	@GameTest(environment = "opennpc-test:solo_sprint", maxTicks = 500)
	public void keeps_up_with_a_running_owner(GameTestHelper h) {
		// he sprints (5.6 blocks a second, a player's run) 50 blocks across the floor, then stops
		Scene s = scene(h, -12, -12, -15, -14);
		double pace = 0.2806;
		int runTicks = (int) Math.ceil(36 * Math.sqrt(2) / pace);
		double[] top = {0}, behind = {0}, half = {0}, end = {0};
		Vec3[] last = {s.ana.position()};
		h.onEachTick(() -> {
			if (s.ana.isRemoved()) return;
			long t = h.getTick();
			if (t <= runTicks) {
				double d = t * pace / Math.sqrt(2);
				s.ownerAt(-12 + d, -12 + d);
				s.ownerFacing(-45);
			}
			Vec3 now = s.ana.position();
			top[0] = Math.max(top[0], Math.hypot(now.x - last[0].x, now.z - last[0].z));
			last[0] = now;
			if (t <= runTicks) behind[0] = Math.max(behind[0], s.dist());
			if (t == runTicks / 2) half[0] = s.dist();
			if (t == runTicks) end[0] = s.dist();
			if (t > runTicks + 20 && !s.ana.isWalking() && s.dist() <= GAP + 1.2) {
				OpenNpc.LOG.info("[test] sprint: top speed {} b/s, farthest behind {}, {} behind halfway through his run and {} when he stopped, ended {} from him", fmt(top[0] * 20), fmt(behind[0]), fmt(half[0]), fmt(end[0]), fmt(s.dist()));
				check(h, behind[0] < 12, "she keeps up with him running (farthest behind " + fmt(behind[0]) + ")");
				check(h, top[0] * 20 < 7.5, "she never moves faster than a running player (" + fmt(top[0] * 20) + " b/s)");
				s.done();
			}
		});
	}

	@GameTest(environment = "opennpc-test:solo_come", maxTicks = 300)
	public void comes_when_called(GameTestHelper h) {
		Scene s = scene(h, 6, 6, 2, 2);
		h.runAfterDelay(10, () -> {
			check(h, !s.ana.isWalking(), "within her gap she waits");
			s.ana.setMode(CompanionEntity.Mode.COME);
		});
		h.onEachTick(() -> {
			if (s.ana.isRemoved() || h.getTick() < 12) return;
			if (s.ana.mode() == CompanionEntity.Mode.FOLLOW && s.dist() <= CompanionEntity.COME_DIST + 0.3) {
				OpenNpc.LOG.info("[test] come: arrived {} from him after {} ticks", fmt(s.dist()), h.getTick() - 10);
				s.done();
			}
		});
	}

	@GameTest(environment = "opennpc-test:solo_stay", maxTicks = 500)
	public void stays_when_told(GameTestHelper h) {
		Scene s = scene(h, 4, 4, 2, 2);
		Vec3[] at = {null};
		h.runAfterDelay(5, () -> { s.ana.setMode(CompanionEntity.Mode.STAY); at[0] = s.ana.position(); });
		h.onEachTick(() -> {
			if (s.ana.isRemoved()) return;
			long t = h.getTick();
			if (t > 5 && t <= 85) s.ownerAt(4 + (t - 5) * 0.2, 4 + (t - 5) * 0.2);   // he walks off 22 blocks
			if (t == 140) {
				double moved = s.ana.position().distanceTo(at[0]);
				check(h, moved < 0.6, "she stayed where she was told (moved " + fmt(moved) + ")");
				check(h, s.dist() > 15, "and he is far away");
				s.ana.setMode(CompanionEntity.Mode.FOLLOW);
			}
			if (t > 140 && !s.ana.isWalking() && s.dist() <= GAP + 1.2) {
				OpenNpc.LOG.info("[test] stay: stayed put, then caught up after {} ticks", t - 140);
				s.done();
			}
		});
	}

	@GameTest(environment = "opennpc-test:solo_far", maxTicks = 200)
	public void catches_up_when_far_away(GameTestHelper h) {
		Scene s = scene(h, -12, -12, -14, -14);
		h.runAfterDelay(20, () -> {
			// 50 blocks in one go (a teleport, an ender pearl): past the point where walking makes sense, so she shows up near him
			s.ownerAt(24, 24);
			s.ownerFacing(-45);
		});
		h.onEachTick(() -> {
			if (s.ana.isRemoved() || h.getTick() < 22) return;
			if (s.dist() < 9) {
				OpenNpc.LOG.info("[test] far: she was {} blocks from him right after the jump", fmt(s.dist()));
				s.done();
			}
		});
	}

	// ---------------------------------------------------------------- the AI link

	static Brain brainFor(Scene s, StandIn ai, List<String> chat) {
		CompanionBody body = new CompanionBody(() -> s.ana, () -> s.owner, () -> "Ana", () -> "Tester", chat::add, p -> null);
		Brain b = new Brain(body, s.level.getServer(), ai.url(), "", "", "auto", line -> OpenNpc.LOG.info("[test] [ai] {}", line));
		s.h.onEachTick(b::tick);
		OpenNpcTestMod.cleanup.add(b::stop);
		return b;
	}

	@GameTest(environment = "opennpc-test:solo_ai_chat", maxTicks = 900)
	public void an_ai_answer_moves_her(GameTestHelper h) {
		Scene s = scene(h, 12, 12, 2, 2);
		StandIn ai = StandIn.start(false, user -> {
			if (user.contains("typed to you: \"please wait right here\"")) return new StandIn.Reply("stay", "ok, waiting here");
			if (user.contains("typed to you: \"come here\"")) return new StandIn.Reply("come", "on my way");
			return new StandIn.Reply(null, null);
		});
		List<String> chat = new ArrayList<>();
		Brain brain = brainFor(s, ai, chat);
		brain.start();
		int[] step = {0};
		h.onEachTick(() -> {
			if (s.ana.isRemoved()) return;
			switch (step[0]) {
				case 0 -> { if (brain.waitDoor() != null) { brain.typed("please wait right here"); step[0] = 1; } }
				case 1 -> {
					if (s.ana.mode() == CompanionEntity.Mode.STAY) {
						JsonObject q = ai.seen.get(0);
						String system = q.getAsJsonArray("messages").get(0).getAsJsonObject().get("content").getAsString();
						String user = q.getAsJsonArray("messages").get(1).getAsJsonObject().get("content").getAsString();
						JsonObject fn = q.getAsJsonArray("tools").get(0).getAsJsonObject().getAsJsonObject("function");
						check(h, fn.get("name").getAsString().equals("act"), "one act tool");
						String en = fn.getAsJsonObject("parameters").getAsJsonObject("properties").getAsJsonObject("action").getAsJsonArray("enum").toString();
						check(h, en.contains("\"follow\"") && en.contains("\"come\"") && en.contains("\"stay\""), "its actions: follow, come, stay (" + en + ")");
						check(h, system.contains("You control Ana") && system.contains("Tester"), "the instructions name her and her owner");
						check(h, system.contains("shows up in the game chat"), "no wait door: told her words go in chat");
						check(h, user.contains("your health: 20/20") && user.contains("distance to Tester:"), "the question has her situation");
						check(h, chat.contains("ok, waiting here"), "the AI's words show in chat (" + chat + ")");
						check(h, Boolean.FALSE.equals(brain.waitDoor()), "the stand-in has no wait door");
						s.ownerAt(20, 20);
						step[0] = 2;
					}
				}
				case 2 -> { if (!brain.busy()) { brain.typed("come here"); step[0] = 3; } }
				case 3 -> {
					if (s.ana.mode() == CompanionEntity.Mode.FOLLOW && s.dist() <= CompanionEntity.COME_DIST + 0.3) {
						check(h, ai.seen.size() == 2, "two questions, one per line he typed (" + ai.seen.size() + ")");
						OpenNpc.LOG.info("[test] ai chat: stay, then come, both from the stand-in AI; chat: {}", chat);
						brain.stop();
						ai.close();
						s.done();
					}
				}
				default -> {}
			}
		});
	}

	@GameTest(environment = "opennpc-test:solo_ai_door", maxTicks = 900)
	public void the_wait_door_asks_when_he_speaks(GameTestHelper h) {
		Scene s = scene(h, 12, 12, 2, 2);
		StandIn ai = StandIn.start(true, user -> user.contains("is with you now") ? new StandIn.Reply(null, "nothing to do") : new StandIn.Reply("come", "coming!"));
		List<String> chat = new ArrayList<>();
		Brain brain = brainFor(s, ai, chat);
		brain.start();
		int[] step = {0};
		long[] at = {0};
		h.onEachTick(() -> {
			if (s.ana.isRemoved()) return;
			long t = h.getTick();
			switch (step[0]) {
				case 0 -> { if (Boolean.TRUE.equals(brain.waitDoor())) { at[0] = t; step[0] = 1; } }
				case 1 -> {
					if (t - at[0] >= 40) {
						check(h, ai.seen.isEmpty(), "waiting with no call: nothing asked (nothing spent)");
						ai.setCall(true);
						at[0] = t;
						step[0] = 2;
					}
				}
				case 2 -> {
					if (ai.seen.size() == 1 && !brain.busy()) {
						String system = ai.seen.get(0).getAsJsonArray("messages").get(0).getAsJsonObject().get("content").getAsString();
						check(h, system.contains("words are never shown"), "with the door, told her words are never shown");
						OpenNpc.LOG.info("[test] door: a call started, asked after {} ticks", t - at[0]);
						ai.speak();
						at[0] = t;
						step[0] = 3;
					}
				}
				case 3 -> {
					if (ai.seen.size() == 2 && s.ana.mode() == CompanionEntity.Mode.COME) {
						OpenNpc.LOG.info("[test] door: he spoke, she got moving {} ticks later", t - at[0]);
						step[0] = 4;
					}
				}
				case 4 -> {
					if (s.ana.mode() == CompanionEntity.Mode.FOLLOW && s.dist() <= CompanionEntity.COME_DIST + 0.3) {
						check(h, chat.isEmpty(), "nothing typed in chat as her (" + chat + ")");
						brain.stop();
						ai.close();
						s.done();
					}
				}
				default -> {}
			}
		});
	}

	// (the test server runs its ticks as fast as it can, 900 in under a second on one run, while the stand-in answers in real time:
	// time is measured by the clock here, there are ticks to spare, and a new name is only set while her door question waits)
	@GameTest(environment = "opennpc-test:solo_ai_name", maxTicks = 6000)
	public void the_app_names_her(GameTestHelper h) {
		Scene s = scene(h, 12, 12, 2, 2);
		StandIn ai = StandIn.start(true, user -> new StandIn.Reply(null, "nothing to do"));
		ai.setName("Yui");
		opennpc.NpcConfig cfg = new opennpc.NpcConfig();   // (the defaults: name Ana, the app's name allowed)
		Brain[] holder = {null};
		CompanionBody body = new CompanionBody(() -> s.ana, () -> s.owner, () -> cfg.shownName(holder[0] == null ? "" : holder[0].appName()), () -> "Tester", line -> {}, p -> null);
		Brain brain = new Brain(body, s.level.getServer(), ai.url(), "", "", "auto", line -> OpenNpc.LOG.info("[test] [ai] {}", line));
		holder[0] = brain;
		int[] changed = {0};
		// (as the companion manager does: the one in the world takes the name the moment it changes)
		brain.onAppName = () -> { changed[0]++; s.ana.setName(cfg.shownName(brain.appName())); };
		h.onEachTick(brain::tick);
		OpenNpcTestMod.cleanup.add(brain::stop);
		check(h, s.ana.getCustomName() != null && s.ana.getCustomName().getString().equals("Ana"), "before the app answers she is Ana");
		brain.start();
		int[] step = {0};
		long[] at = {0};
		h.onEachTick(() -> {
			if (s.ana.isRemoved()) return;
			long now = System.currentTimeMillis();
			String shown = s.ana.getCustomName() == null ? "" : s.ana.getCustomName().getString();
			switch (step[0]) {
				case 0 -> {
					if (shown.equals("Yui")) {
						check(h, brain.appName().equals("Yui") && changed[0] == 1, "the app's name came on the door, once (" + changed[0] + ")");
						ai.setCall(true);
						step[0] = 1;
					}
				}
				case 1 -> {
					// (each new pick while her door question is waiting, as a person picking in the app would; see StandIn.parked)
					if (ai.seen.size() == 1 && !brain.busy() && ai.parked()) {
						String system = ai.seen.get(0).getAsJsonArray("messages").get(0).getAsJsonObject().get("content").getAsString();
						check(h, system.contains("You control Yui") && !system.contains("Ana"), "her instructions use the app's name");
						ai.setName("Mila");   // (another companion picked in the app)
						at[0] = now;
						step[0] = 2;
					}
				}
				case 2 -> {
					if (shown.equals("Mila")) {
						OpenNpc.LOG.info("[test] name: a new pick showed after {} ms", now - at[0]);
						check(h, now - at[0] < 3000, "a new pick shows within 3 seconds (" + (now - at[0]) + " ms)");
						cfg.useAppName = false;   // (renamed in the game: her own name stays)
						brain.onAppName.run();
						check(h, s.ana.getCustomName().getString().equals("Ana"), "with the app's name turned off she is her setting's name");
						cfg.useAppName = true;
						step[0] = 3;
					}
				}
				case 3 -> {
					if (ai.parked()) {
						ai.setName(null);
						step[0] = 4;
					}
				}
				case 4 -> {
					if (changed[0] == 4) {   // (the door's answer with no name)
						check(h, brain.appName().isEmpty() && shown.equals("Ana"), "a door with no name: back to her setting (" + shown + ")");
						check(h, opennpc.NpcConfig.cleanOrEmpty(" Zoë!\n") .equals("Zoë") && opennpc.NpcConfig.cleanOrEmpty("a very long name here!!").equals("a very long name"), "names: any language's letters, 16 at most");
						brain.stop();
						ai.close();
						s.done();
					}
				}
				default -> {}
			}
		});
	}

	@GameTest(environment = "opennpc-test:solo_lines", maxTicks = 20)
	public void event_lines(GameTestHelper h) {
		check(h, Brain.describe("task_failed", Map.of("task", "mining iron", "reason", "no pickaxe"), "Steve").equals("gave up on mining iron: no pickaxe"), "a failed job");
		check(h, Brain.describe("player_died", Map.of("cause", "Steve fell"), "Steve").equals("Steve died (Steve fell)"), "the owner died");
		check(h, Brain.describe("something_new", Map.of(), "Steve").isEmpty(), "unknown events say nothing");
		h.succeed();
	}

	static String short3(Vec3 v) { return fmt(v.x) + "," + fmt(v.y) + "," + fmt(v.z); }

	static String fmt(double d) { return String.format(java.util.Locale.ROOT, "%.2f", d); }
}
