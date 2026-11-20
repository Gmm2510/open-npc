package opennpc.test;

import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.List;
import net.fabricmc.fabric.api.gametest.v1.GameTest;
import net.minecraft.core.BlockPos;
import net.minecraft.gametest.framework.GameTestHelper;
import net.minecraft.tags.BlockTags;
import net.minecraft.tags.ItemTags;
import net.minecraft.world.Difficulty;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.LeavesBlock;
import net.minecraft.world.phys.Vec3;
import opennpc.CompanionBody;
import opennpc.OpenNpc;
import opennpc.brain.Brain;
import opennpc.entity.CompanionEntity;
import opennpc.jobs.CraftJob;
import opennpc.jobs.Fight;
import opennpc.jobs.GatherWood;
import opennpc.jobs.Give;
import opennpc.jobs.Mine;
import opennpc.jobs.PickUp;

/**
 * Step 2, the jobs, in a real (headless) Minecraft server: chop a tree and hand over the logs, leave a log wall (a build)
 * alone, mine coal she can see, craft a pickaxe at a table she sets down and packs up again, fight a monster, pick up
 * and hand over items, and a job the stand-in AI asks for makes it ask again when the job is done.
 */
public class JobGameTests {
	static CompanionGameTests.Scene scene(GameTestHelper h, List<String> events) {
		CompanionGameTests.Scene s = CompanionGameTests.scene(h, 2, 2, 4, 2);
		s.ana().events = (e, d) -> events.add(e + ": " + d);
		return s;
	}

	/** An oak tree: a 5-high trunk with natural leaves around the top. */
	static void tree(GameTestHelper h, int x, int z) {
		for (int y = 0; y < 5; y++) h.setBlock(x, y, z, Blocks.OAK_LOG);
		for (int dx = -2; dx <= 2; dx++) for (int dz = -2; dz <= 2; dz++) for (int y = 3; y <= 5; y++) {
			if ((dx == 0 && dz == 0 && y < 5) || (Math.abs(dx) == 2 && Math.abs(dz) == 2)) continue;
			h.setBlock(new BlockPos(x + dx, y, z + dz), Blocks.OAK_LEAVES.defaultBlockState().setValue(LeavesBlock.PERSISTENT, false).setValue(LeavesBlock.DISTANCE, 1));
		}
	}

	/** What she tossed to him (lying near him) plus what he holds. */
	static int handed(CompanionGameTests.Scene s, java.util.function.Predicate<ItemStack> p) {
		int n = 0;
		for (ItemEntity e : s.level().getEntitiesOfClass(ItemEntity.class, s.owner().getBoundingBox().inflate(6), e -> e.getOwner() == s.ana())) if (p.test(e.getItem())) n += e.getItem().getCount();
		for (int i = 0; i < s.owner().getInventory().getContainerSize(); i++) if (p.test(s.owner().getInventory().getItem(i))) n += s.owner().getInventory().getItem(i).getCount();
		return n;
	}

	static void when(GameTestHelper h, CompanionGameTests.Scene s, Runnable check) {
		h.onEachTick(() -> {
			if (s.ana().isRemoved() || s.ana().job() != null || h.getTick() < 5) return;
			check.run();
			s.done();
		});
	}

	@GameTest(environment = "opennpc-test:job_chop", maxTicks = 3000)
	public void chops_a_tree_and_hands_over_the_logs(GameTestHelper h) {
		List<String> ev = new ArrayList<>();
		var s = scene(h, ev);
		tree(h, 12, 12);
		h.runAfterDelay(2, () -> s.ana().startJob(new GatherWood(s.ana(), true, 3, "", true)));
		when(h, s, () -> {
			int logs = handed(s, st -> st.is(ItemTags.LOGS));
			int left = 0;
			for (int y = 0; y < 5; y++) if (h.getBlockState(new BlockPos(12, y, 12)).is(BlockTags.LOGS)) left++;
			OpenNpc.LOG.info("[test] chop: {} logs handed over, {} left on the tree, events {}", logs, left, ev);
			h.assertTrue(logs >= 3, "she handed him at least 3 logs (" + logs + ")");
			h.assertTrue(left <= 2, "they came off the tree (" + left + " logs left)");
			h.assertTrue(ev.stream().anyMatch(e -> e.startsWith("task_done") && e.contains("gave")), "the job ends with a report: " + ev);
		});
	}

	@GameTest(environment = "opennpc-test:job_cliff", maxTicks = 3000)
	public void skips_a_tree_she_cant_walk_to(GameTestHelper h) {
		List<String> ev = new ArrayList<>();
		var s = scene(h, ev);
		// the nearest tree stands on a block of stone 3 high with sheer sides (no way up), too far in to reach from the ground; another
		// tree is on the ground farther off. On a real hill she followed a walk that couldn't get there and ended in a crevice under
		// the tree, then tried its logs one by one for a minute.
		for (int x = 7; x <= 13; x++) for (int z = 7; z <= 13; z++) for (int y = 0; y < 3; y++) h.setBlock(x, y, z, Blocks.STONE);
		for (int y = 3; y < 8; y++) h.setBlock(10, y, 10, Blocks.OAK_LOG);
		for (int dx = -2; dx <= 2; dx++) for (int dz = -2; dz <= 2; dz++) for (int y = 6; y <= 8; y++) {
			if ((dx == 0 && dz == 0 && y < 8) || (Math.abs(dx) == 2 && Math.abs(dz) == 2)) continue;
			h.setBlock(new BlockPos(10 + dx, y, 10 + dz), Blocks.OAK_LEAVES.defaultBlockState().setValue(LeavesBlock.PERSISTENT, false).setValue(LeavesBlock.DISTANCE, 1));
		}
		tree(h, 22, 22);
		long[] firstFar = {-1};
		h.onEachTick(() -> {
			if (firstFar[0] < 0 && !h.getBlockState(new BlockPos(22, 0, 22)).is(BlockTags.LOGS)) firstFar[0] = h.getTick();
		});
		h.runAfterDelay(2, () -> s.ana().startJob(new GatherWood(s.ana(), true, 3, "", true)));
		when(h, s, () -> {
			int logs = handed(s, st -> st.is(ItemTags.LOGS));
			int high = 0;
			for (int y = 3; y < 8; y++) if (h.getBlockState(new BlockPos(10, y, 10)).is(BlockTags.LOGS)) high++;
			OpenNpc.LOG.info("[test] cliff: {} logs handed over, the far tree's first log off at tick {}, {} of 5 logs left up on the stone, events {}", logs, firstFar[0], high, ev);
			h.assertTrue(logs >= 3, "she brought 3 logs from the tree she can walk to (" + logs + ")");
			h.assertTrue(high == 5, "the tree up on the stone is untouched (" + high + " of 5 logs left)");
			h.assertTrue(firstFar[0] > 0 && firstFar[0] < 500, "she gave up on the one she can't walk to at once: the other tree's first log came off at tick " + firstFar[0]);
		});
	}

	@GameTest(environment = "opennpc-test:job_hole", maxTicks = 3000)
	public void gets_out_of_a_hole_to_chop(GameTestHelper h) {
		List<String> ev = new ArrayList<>();
		var s = scene(h, ev);
		// she is at the bottom of a shaft 5 blocks deep with sheer sides, the only tree is out by the owner (on a real hill her walk
		// ended in a crevice and she stayed there through two calls)
		for (int x = 3; x <= 5; x++) for (int z = 3; z <= 5; z++) for (int y = 0; y < 5; y++) if (x != 4 || z != 4) h.setBlock(x, y, z, Blocks.STONE);
		s.ana().snapTo(h.absoluteVec(new net.minecraft.world.phys.Vec3(4.5, 0, 4.5)).x, h.absoluteVec(new net.minecraft.world.phys.Vec3(4.5, 0, 4.5)).y, h.absoluteVec(new net.minecraft.world.phys.Vec3(4.5, 0, 4.5)).z, 0, 0);
		s.ownerAt(18, 18);
		tree(h, 22, 22);
		h.runAfterDelay(2, () -> s.ana().startJob(new GatherWood(s.ana(), true, 3, "", true)));
		when(h, s, () -> {
			int logs = handed(s, st -> st.is(ItemTags.LOGS));
			OpenNpc.LOG.info("[test] hole: {} logs handed over, events {}", logs, ev);
			h.assertTrue(logs >= 3, "she got out and brought 3 logs (" + logs + ")");
		});
	}

	@GameTest(environment = "opennpc-test:job_rise", maxTicks = 1000)
	public void hands_over_to_an_owner_up_a_rise(GameTestHelper h) {
		List<String> ev = new ArrayList<>();
		var s = scene(h, ev);
		// he stands on a platform 3 high with sheer sides that she can't walk up (on a real hill she gave up after a minute with 7 logs)
		for (int x = 14; x <= 20; x++) for (int z = 14; z <= 20; z++) for (int y = 0; y < 3; y++) h.setBlock(x, y, z, Blocks.STONE);
		var top = h.absoluteVec(new net.minecraft.world.phys.Vec3(17.5, 3, 17.5));
		h.runAfterDelay(2, () -> {
			s.owner().snapTo(top.x, top.y, top.z, 0, 0);
			s.ana().addToBag(new ItemStack(net.minecraft.world.item.Items.OAK_LOG, 5));
			s.ana().startJob(new Give(s.ana(), true, st -> st.is(ItemTags.LOGS), 5, "logs"));
		});
		when(h, s, () -> {
			int logs = handed(s, st -> st.is(ItemTags.LOGS));
			OpenNpc.LOG.info("[test] rise: {} logs handed over at tick {}, events {}", logs, h.getTick(), ev);
			h.assertTrue(logs >= 5, "she got the logs to him up on the rise (" + logs + ")");
		});
	}

	@GameTest(environment = "opennpc-test:job_low", maxTicks = 3000)
	public void chops_a_low_tree_through_its_leaves(GameTestHelper h) {
		List<String> ev = new ArrayList<>();
		var s = scene(h, ev);
		// a bushy oak: leaves all around the trunk from head height up, so every spot near it is in the leaves
		for (int y = 0; y < 4; y++) h.setBlock(12, y, 12, Blocks.OAK_LOG);
		for (int dx = -3; dx <= 3; dx++) for (int dz = -3; dz <= 3; dz++) for (int y = 1; y <= 4; y++) {
			if (dx == 0 && dz == 0 && y < 4) continue;
			if (Math.abs(dx) + Math.abs(dz) > 4) continue;
			h.setBlock(new BlockPos(12 + dx, y, 12 + dz), Blocks.OAK_LEAVES.defaultBlockState().setValue(LeavesBlock.PERSISTENT, false).setValue(LeavesBlock.DISTANCE, 1));
		}
		h.runAfterDelay(2, () -> s.ana().startJob(new GatherWood(s.ana(), true, 2, "", true)));
		when(h, s, () -> {
			int logs = handed(s, st -> st.is(ItemTags.LOGS));
			OpenNpc.LOG.info("[test] low tree: {} logs handed over, events {}", logs, ev);
			h.assertTrue(logs >= 2, "she got through the leaves and brought 2 logs (" + logs + ")");
		});
	}

	@GameTest(environment = "opennpc-test:job_build", maxTicks = 600)
	public void leaves_a_log_wall_alone(GameTestHelper h) {
		List<String> ev = new ArrayList<>();
		var s = scene(h, ev);
		// a wall of logs with no leaves (a build), and leaves a player placed (persistent) on another
		for (int x = 8; x <= 12; x++) for (int y = 0; y < 3; y++) h.setBlock(x, y, 12, Blocks.SPRUCE_LOG);
		for (int y = 0; y < 3; y++) h.setBlock(16, y, 6, Blocks.OAK_LOG);
		h.setBlock(new BlockPos(16, 3, 6), Blocks.OAK_LEAVES.defaultBlockState().setValue(LeavesBlock.PERSISTENT, true));
		h.runAfterDelay(2, () -> s.ana().startJob(new GatherWood(s.ana(), true, 3, "", true)));
		when(h, s, () -> {
			int wall = 0;
			for (int x = 8; x <= 12; x++) for (int y = 0; y < 3; y++) if (h.getBlockState(new BlockPos(x, y, 12)).is(BlockTags.LOGS)) wall++;
			for (int y = 0; y < 3; y++) if (h.getBlockState(new BlockPos(16, y, 6)).is(BlockTags.LOGS)) wall++;
			OpenNpc.LOG.info("[test] build: {} of 18 logs still there, events {}", wall, ev);
			h.assertTrue(wall == 18, "nothing of the builds was chopped (" + wall + "/18)");
			h.assertTrue(ev.stream().anyMatch(e -> e.startsWith("task_failed") && e.contains("no trees")), "she says there are no trees: " + ev);
		});
	}

	@GameTest(environment = "opennpc-test:job_coal", maxTicks = 2400)
	public void mines_coal_she_can_see(GameTestHelper h) {
		List<String> ev = new ArrayList<>();
		var s = scene(h, ev);
		// a little rock face with coal showing on its side
		for (int x = 10; x <= 13; x++) for (int y = 0; y <= 2; y++) for (int z = 10; z <= 12; z++) h.setBlock(x, y, z, Blocks.STONE);
		h.setBlock(10, 1, 11, Blocks.COAL_ORE);
		h.setBlock(11, 1, 11, Blocks.COAL_ORE);
		h.setBlock(12, 1, 11, Blocks.COAL_ORE);   // (hidden inside: she gets to it once the others are out)
		s.ana().addToBag(new ItemStack(Items.WOODEN_PICKAXE));
		BlockPos under = s.ana().blockPosition().below();
		h.runAfterDelay(2, () -> s.ana().startJob(new Mine(s.ana(), true, Mine.Kind.COAL, 2, true)));
		when(h, s, () -> {
			int coal = handed(s, st -> st.is(Items.COAL));
			OpenNpc.LOG.info("[test] coal: {} handed over, events {}", coal, ev);
			h.assertTrue(coal >= 2, "she brought him 2 coal (" + coal + ")");
			h.assertTrue(!s.level().getBlockState(under).isAir(), "she didn't dig down where she stood");
			h.assertTrue(s.level().getBlockState(h.absolutePos(new BlockPos(11, 2, 11))).is(Blocks.STONE), "and left the stone around it");
		});
	}

	@GameTest(environment = "opennpc-test:job_craft", maxTicks = 2400)
	public void crafts_a_pickaxe_at_a_table_she_packs_up(GameTestHelper h) {
		List<String> ev = new ArrayList<>();
		var s = scene(h, ev);
		s.ana().addToBag(new ItemStack(Items.OAK_LOG, 3));
		h.runAfterDelay(2, () -> s.ana().startJob(new CraftJob(s.ana(), true, Items.WOODEN_PICKAXE, 1, false)));
		when(h, s, () -> {
			int tables = 0;
			for (BlockPos p : BlockPos.betweenClosed(s.ana().blockPosition().offset(-6, -2, -6), s.ana().blockPosition().offset(6, 3, 6))) if (s.level().getBlockState(p).is(Blocks.CRAFTING_TABLE)) tables++;
			OpenNpc.LOG.info("[test] craft: bag {}, tables left out {}, events {}", s.ana().bag(), tables, ev);
			h.assertTrue(s.ana().countItem(Items.WOODEN_PICKAXE) == 1, "she made a wooden pickaxe (and a table) from 3 logs");
			h.assertTrue(tables == 0, "she packed up the table she set down");
			h.assertTrue(s.ana().countItem(Items.CRAFTING_TABLE) == 1, "and carries it");
		});
	}

	@GameTest(environment = "opennpc-test:job_fight", maxTicks = 1200)
	public void fights_a_monster(GameTestHelper h) {
		List<String> ev = new ArrayList<>();
		var s = scene(h, ev);
		Difficulty before = h.getLevel().getDifficulty();
		h.getLevel().getServer().setDifficulty(Difficulty.NORMAL, true);
		s.ana().addToBag(new ItemStack(Items.IRON_SWORD));
		var husk = (net.minecraft.world.entity.Mob) h.spawn(opennpc.jobs.Versions.entityType("husk"), new Vec3(8, 0, 8));
		husk.setNoAi(true);   // (a target that stands still, so the test is about her)
		// (only this husk: any other monster around goes)
		for (var e : s.level().getEntitiesOfClass(net.minecraft.world.entity.LivingEntity.class, s.owner().getBoundingBox().inflate(48), e -> e instanceof net.minecraft.world.entity.monster.Enemy && e != husk)) e.discard();
		h.runAfterDelay(2, () -> s.ana().startJob(new Fight(s.ana(), true, null, false)));
		when(h, s, () -> {
			OpenNpc.LOG.info("[test] fight: husk alive {}, she holds {}, events {}", husk.isAlive(), s.ana().getMainHandItem(), ev);
			h.assertTrue(!husk.isAlive(), "the husk is down");
			h.assertTrue(s.ana().getMainHandItem().is(Items.IRON_SWORD), "she fought with her sword");
			h.getLevel().getServer().setDifficulty(before, true);
		});
	}

	@GameTest(environment = "opennpc-test:job_pickup", maxTicks = 1500)
	public void picks_up_and_hands_over(GameTestHelper h) {
		List<String> ev = new ArrayList<>();
		var s = scene(h, ev);
		for (int i = 0; i < 3; i++) {
			Vec3 at = h.absoluteVec(new Vec3(9 + i, 0.2, 7));
			ItemEntity e = new ItemEntity(s.level(), at.x, at.y, at.z, new ItemStack(Items.APPLE, 2));
			s.level().addFreshEntity(e);
		}
		int[] stage = {0};
		h.onEachTick(() -> {
			if (s.ana().isRemoved() || h.getTick() < 3) return;
			if (stage[0] == 0) { s.ana().startJob(new PickUp(s.ana(), true)); stage[0] = 1; return; }
			if (s.ana().job() != null) return;
			if (stage[0] == 1) {
				h.assertTrue(s.ana().countItem(Items.APPLE) == 6, "she picked up all 6 apples (" + s.ana().countItem(Items.APPLE) + ")");
				s.ana().startJob(new Give(s.ana(), true, st -> st.is(Items.APPLE), 0, "apples"));
				stage[0] = 2;
				return;
			}
			int apples = handed(s, st -> st.is(Items.APPLE));
			OpenNpc.LOG.info("[test] pickup: {} apples handed over, events {}", apples, ev);
			h.assertTrue(apples == 6, "she handed him all 6 (" + apples + ")");
			h.assertTrue(s.ana().countItem(Items.APPLE) == 0, "and kept none (she doesn't pick her own tosses back up)");
			s.done();
		});
	}

	@GameTest(environment = "opennpc-test:job_ai", maxTicks = 3000)
	public void an_ai_job_reports_back(GameTestHelper h) {
		var s = CompanionGameTests.scene(h, 2, 2, 4, 2);
		tree(h, 12, 12);
		StandIn ai = StandIn.start(false, user -> user.contains("typed to you: \"get me some wood\"") ? new StandIn.Reply("gather_wood", "on it") : new StandIn.Reply(null, null));
		List<String> chat = new ArrayList<>();
		CompanionBody body = new CompanionBody(s::ana, s::owner, () -> "Ana", () -> "Tester", chat::add, p -> null);
		Brain brain = new Brain(body, s.level().getServer(), ai.url(), "", "", "auto", line -> OpenNpc.LOG.info("[test] [ai] {}", line));
		s.ana().events = (e, d) -> brain.event(e, d, false);
		h.onEachTick(brain::tick);
		OpenNpcTestMod.cleanup.add(brain::stop);
		brain.start();
		int[] stage = {0};
		h.onEachTick(() -> {
			if (s.ana().isRemoved()) return;
			if (stage[0] == 0 && brain.waitDoor() != null) { brain.typed("get me some wood"); stage[0] = 1; }
			if (stage[0] == 1 && s.ana().job() instanceof GatherWood) stage[0] = 2;
			if (stage[0] == 2 && s.ana().job() == null && ai.seen.size() >= 2) {
				JsonObject first = ai.seen.get(0);
				String en = first.getAsJsonArray("tools").get(0).getAsJsonObject().getAsJsonObject("function").getAsJsonObject("parameters").getAsJsonObject("properties").getAsJsonObject("action").getAsJsonArray("enum").toString();
				String second = ai.seen.get(1).getAsJsonArray("messages").get(1).getAsJsonObject().get("content").getAsString();
				OpenNpc.LOG.info("[test] ai job: second question:\n{}", second);
				h.assertTrue(en.contains("\"gather_wood\"") && en.contains("\"give_loot\"") && en.contains("\"mine_iron\""), "the act tool lists the jobs (" + en + ")");
				h.assertTrue(second.contains("finished chopping wood"), "when the job ends it asks again and says how it went");
				h.assertTrue(second.contains("your tools:") && second.contains("carrying:"), "and what she has");
				h.assertTrue(chat.contains("on it"), "the AI's words went to chat");
				brain.stop();
				ai.close();
				s.done();
			}
		});
	}
}
