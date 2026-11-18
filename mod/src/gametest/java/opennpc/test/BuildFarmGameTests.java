package opennpc.test;

import java.util.ArrayList;
import java.util.List;
import net.fabricmc.fabric.api.gametest.v1.GameTest;
import net.minecraft.core.BlockPos;
import net.minecraft.gametest.framework.GameTestHelper;
import net.minecraft.tags.BlockTags;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.CropBlock;
import net.minecraft.world.level.block.DoorBlock;
import net.minecraft.world.level.block.state.BlockState;
import opennpc.OpenNpc;
import opennpc.jobs.BuildHouse;
import opennpc.jobs.Farm;

/**
 * Step 3 in a real (headless) Minecraft server: she builds a small house (making her own door at a table), makes and
 * plants a field (making her own hoe first), and harvests ripe wheat and plants it again.
 */
public class BuildFarmGameTests {
	static int count(GameTestHelper h, int x0, int y0, int z0, int x1, int y1, int z1, java.util.function.Predicate<BlockState> p) {
		int n = 0;
		for (BlockPos b : BlockPos.betweenClosed(h.absolutePos(new BlockPos(x0, y0, z0)), h.absolutePos(new BlockPos(x1, y1, z1)))) if (p.test(h.getLevel().getBlockState(b))) n++;
		return n;
	}

	/** A patch of grass in the floor, with a water source in the middle. */
	static void grass(GameTestHelper h, int x0, int z0, int size, boolean water) {
		for (int x = x0; x < x0 + size; x++) for (int z = z0; z < z0 + size; z++) h.setBlock(x, -1, z, Blocks.GRASS_BLOCK);
		if (water) h.setBlock(x0 + size / 2, -1, z0 + size / 2, Blocks.WATER);
	}

	@GameTest(environment = "opennpc-test:build_house", maxTicks = 6000)
	public void builds_a_small_house(GameTestHelper h) {
		List<String> ev = new ArrayList<>();
		var s = JobGameTests.scene(h, ev);
		grass(h, -14, -14, 40, false);   // (grass ground, like a real world)
		s.ana().addToBag(new ItemStack(Items.OAK_PLANKS, 64));
		s.ana().addToBag(new ItemStack(Items.OAK_PLANKS, 20));
		s.ana().addToBag(new ItemStack(Items.OAK_LOG, 12));
		h.runAfterDelay(2, () -> s.ana().startJob(new BuildHouse(s.ana(), true)));
		JobGameTests.when(h, s, () -> {
			// find her door, then look at the house around it
			BlockPos door = null;
			for (BlockPos b : BlockPos.betweenClosed(h.absolutePos(new BlockPos(-16, 0, -16)), h.absolutePos(new BlockPos(27, 2, 27)))) {
				BlockState st = h.getLevel().getBlockState(b);
				if (st.getBlock() instanceof DoorBlock && st.getValue(DoorBlock.HALF) == net.minecraft.world.level.block.state.properties.DoubleBlockHalf.LOWER) { door = b.immutable(); break; }
			}
			OpenNpc.LOG.info("[test] house: door {}, events {}", door, ev);
			h.assertTrue(door != null, "the house has a door");
			int walls = 0, roof = 0;
			for (BlockPos b : BlockPos.betweenClosed(door.offset(-5, 0, -5), door.offset(5, 2, 5))) {
				BlockState st = h.getLevel().getBlockState(b);
				if (st.is(BlockTags.PLANKS) || st.is(BlockTags.LOGS)) walls++;
			}
			for (BlockPos b : BlockPos.betweenClosed(door.offset(-5, 3, -5), door.offset(5, 3, 5))) if (h.getLevel().getBlockState(b).is(BlockTags.PLANKS)) roof++;
			OpenNpc.LOG.info("[test] house: {} wall blocks, {} roof blocks, she carries {}", walls, roof, s.ana().bag());
			h.assertTrue(walls >= 40, "walls up (" + walls + " blocks)");
			h.assertTrue(roof == 25, "a full roof (" + roof + " of 25)");
			h.assertTrue(ev.stream().anyMatch(e -> e.startsWith("task_done") && e.contains("built a small wooden house")), "she says she built it: " + ev);
			h.assertTrue(count(h, -16, 0, -16, 27, 6, 27, st -> st.is(Blocks.CRAFTING_TABLE)) == 0, "her crafting table is packed up");
		});
	}

	@GameTest(environment = "opennpc-test:farm_plant", maxTicks = 4000)
	public void makes_a_hoe_and_plants_a_field(GameTestHelper h) {
		List<String> ev = new ArrayList<>();
		var s = JobGameTests.scene(h, ev);
		grass(h, 8, 8, 7, true);
		s.ana().addToBag(new ItemStack(Items.OAK_LOG, 2));
		s.ana().addToBag(new ItemStack(Items.WHEAT_SEEDS, 9));
		h.runAfterDelay(2, () -> s.ana().startJob(new Farm(s.ana(), true, 9, false)));
		JobGameTests.when(h, s, () -> {
			int crops = count(h, 6, 0, 6, 16, 0, 16, st -> st.is(Blocks.WHEAT));
			int farmland = count(h, 6, -1, 6, 16, -1, 16, st -> st.is(Blocks.FARMLAND));
			OpenNpc.LOG.info("[test] field: {} farmland, {} wheat planted, she has a hoe {}, events {}", farmland, crops, s.ana().count(st -> st.is(net.minecraft.tags.ItemTags.HOES)), ev);
			h.assertTrue(s.ana().countItem(Items.WOODEN_HOE) == 1, "she made a wooden hoe");
			h.assertTrue(crops == 9 && farmland >= 9, "9 squares tilled and sown (" + farmland + " farmland, " + crops + " wheat)");
			h.assertTrue(h.getLevel().getBlockState(h.absolutePos(new BlockPos(11, -1, 11))).is(Blocks.WATER), "the water is still there");
		});
	}

	@GameTest(environment = "opennpc-test:farm_harvest", maxTicks = 3000)
	public void harvests_and_plants_again(GameTestHelper h) {
		List<String> ev = new ArrayList<>();
		var s = JobGameTests.scene(h, ev);
		grass(h, 8, 8, 5, false);
		h.setBlock(11, -1, 11, Blocks.WATER);   // (a real field has water near it)
		for (int x = 9; x <= 10; x++) for (int z = 9; z <= 10; z++) {
			h.setBlock(x, -1, z, Blocks.FARMLAND);
			h.setBlock(new BlockPos(x, 0, z), ((CropBlock) Blocks.WHEAT).getStateForAge(7));
		}
		s.ana().addToBag(new ItemStack(Items.WHEAT_SEEDS, 2));   // (a couple spare: a ripe plant can drop no seeds)
		h.runAfterDelay(2, () -> s.ana().startJob(new Farm(s.ana(), true, 25, true)));
		JobGameTests.when(h, s, () -> {
			int young = count(h, 9, 0, 9, 10, 0, 10, st -> st.is(Blocks.WHEAT) && ((CropBlock) Blocks.WHEAT).getAge(st) < 7);
			int ripe = count(h, 9, 0, 9, 10, 0, 10, st -> st.is(Blocks.WHEAT) && ((CropBlock) Blocks.WHEAT).getAge(st) == 7);
			OpenNpc.LOG.info("[test] harvest: she has {} wheat, {} replanted, {} still ripe, events {}", s.ana().countItem(Items.WHEAT), young, ripe, ev);
			h.assertTrue(s.ana().countItem(Items.WHEAT) == 4, "she picked all 4 (" + s.ana().countItem(Items.WHEAT) + " wheat)");
			h.assertTrue(ripe == 0 && young == 4, "and planted all 4 again (" + young + ")");
		});
	}
}
