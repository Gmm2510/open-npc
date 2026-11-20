package opennpc.jobs;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.function.Predicate;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.Identifier;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.tags.BlockTags;
import net.minecraft.tags.ItemTags;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.levelgen.Heightmap;
import net.minecraft.world.phys.Vec3;
import opennpc.entity.CompanionEntity;
import org.jspecify.annotations.Nullable;

/**
 * Builds a small wooden house near the owner: 5 by 5 outside (3 by 3 inside), walls three high with log corners when she
 * has logs, two window openings, a flat plank roof, and a door on the side facing the owner.
 *
 * She picks a level, open spot (natural ground only, nothing of anyone's on it, no trees or water in the way), clears the
 * grass and little bumps, fills dips, gets the wood she needs (chopping trees, crafting planks and a door), then builds
 * the walls layer by layer walking round, the roof from the edges in, and hangs the door last.
 */
public final class BuildHouse extends Work {
	private enum Phase { SITE, WOOD, PLANKS, DOOR, CLEAR, BUILD, FINISH }

	static final int SIZE = 5, HEIGHT = 3;

	private record Op(BlockPos pos, boolean place, int layer, Predicate<ItemStack> material, Direction facing) {}

	private Phase phase = Phase.SITE;
	private @Nullable BlockPos origin;      // the floor-level corner (lowest x, z)
	private Direction doorSide = Direction.NORTH;
	private final List<Op> clear = new ArrayList<>();
	private final List<Op> build = new ArrayList<>();
	private @Nullable Work sub;
	private @Nullable Breaker breaker;
	private @Nullable Placer placer;
	private @Nullable Collect collect;
	private boolean triedWood = false;
	private @Nullable Boolean logCorners;   // log corners all the way up when she has the logs to spare, else planks
	private int placed = 0, skipped = 0;
	private final java.util.Map<BlockPos, Integer> tries = new java.util.HashMap<>();

	public BuildHouse(CompanionEntity c, boolean byPlayer) {
		super(c, byPlayer);
	}

	@Override
	public String label() { return "building a house"; }

	@Override
	public String progress() {
		return switch (phase) {
			case SITE -> "looking for a spot";
			case WOOD, PLANKS, DOOR -> sub != null ? "first: " + sub.label() : "getting the wood ready";
			case CLEAR -> "clearing the spot";
			case BUILD, FINISH -> placed + "/" + (placed + build.size()) + " blocks";
		};
	}

	static final Predicate<ItemStack> PLANKS = s -> s.is(ItemTags.PLANKS);
	static final Predicate<ItemStack> LOGS = s -> s.is(ItemTags.LOGS);
	static final Predicate<ItemStack> DOORS = s -> s.is(ItemTags.WOODEN_DOORS);
	static final Predicate<ItemStack> FILL = s -> s.is(Items.DIRT) || s.is(Items.COBBLESTONE) || s.is(Items.COBBLED_DEEPSLATE) || s.is(ItemTags.PLANKS);

	@Override
	protected Status step(ServerLevel level) {
		if (ticks > 20 * 60 * 12) return fail("took too long");
		if (sub != null) {
			Status s = sub.tick(level);
			if (s == Status.RUNNING) return s;
			Work w = sub;
			sub = null;
			if (s == Status.FAILED) return fail("couldn't get the wood ready: " + w.reason);
			return Status.RUNNING;
		}
		switch (phase) {
			case SITE -> {
				if (!findSite(level)) return fail("no level, open spot near you for a house (it needs about 7 by 7 of flat ground)");
				plan(level);
				phase = Phase.WOOD;
			}
			case WOOD -> {
				int need = planksNeeded() + (c.count(DOORS) > 0 ? 0 : 6) + (c.countItem(Items.CRAFTING_TABLE) > 0 ? 0 : 4);
				int have = c.count(PLANKS) + 4 * c.count(LOGS);
				if (have < need) {
					if (triedWood) return fail("not enough wood: needs " + need + " planks' worth, has " + have);
					triedWood = true;
					sub = new GatherWood(c, byPlayer, (need - have + 3) / 4 + 1, "", false);
					return Status.RUNNING;
				}
				phase = Phase.PLANKS;
			}
			case PLANKS -> {
				int corners = (int) build.stream().filter(op -> isCorner(op.pos())).count();
				int need = planksNeeded() + (c.count(DOORS) > 0 ? 0 : 6) + (c.countItem(Items.CRAFTING_TABLE) > 0 ? 0 : 4);
				if (logCorners == null) logCorners = c.count(PLANKS) + (c.count(LOGS) - corners) * 4 >= need - corners;
				if (logCorners) need -= corners;
				if (c.count(PLANKS) < need) {
					Item log = c.bag().keySet().stream().filter(i -> new ItemStack(i).is(ItemTags.LOGS)).max(Comparator.comparingInt(i -> c.countItem(i))).orElse(null);
					Item planks = log == null ? null : planksFor(log);
					if (planks == null) return fail("no logs to make planks from");
					int spare = c.countItem(log) - (logCorners ? corners : 0);
					if (spare <= 0) return fail("not enough logs for the corners and the planks");
					int more = Math.min(spare * 4, need - c.count(PLANKS));
					sub = new CraftJob(c, byPlayer, planks, Math.max(4, more), false);
					return Status.RUNNING;
				}
				phase = Phase.DOOR;
			}
			case DOOR -> {
				if (c.count(DOORS) == 0) {
					Item planks = c.bag().keySet().stream().filter(i -> new ItemStack(i).is(ItemTags.PLANKS)).max(Comparator.comparingInt(i -> c.countItem(i))).orElse(Items.OAK_PLANKS);
					Item door = doorFor(planks);
					sub = new CraftJob(c, byPlayer, door, 1, false);
					return Status.RUNNING;
				}
				phase = Phase.CLEAR;
			}
			case CLEAR -> {
				if (collect != null) { if (collect.tick(level)) return Status.RUNNING; collect = null; }
				if (breaker != null) {
					Breaker.Result r = breaker.tick(level);
					if (r == Breaker.Result.WORKING) return Status.RUNNING;
					if (r == Breaker.Result.CANT) return fail("couldn't clear the spot: " + breaker.why);
					breaker = null;
					if (clear.isEmpty()) collect = new Collect(c, this::wants, 8);
					return Status.RUNNING;
				}
				Op next = nearest(clear, -1);
				if (next != null) {
					clear.remove(next);
					if (next.place()) { placer = new Placer(c, next.pos(), next.material(), next.facing()); phase = Phase.BUILD; build.add(0, next); }
					else if (!level.getBlockState(next.pos()).isAir()) breaker = new Breaker(c, next.pos());
					return Status.RUNNING;
				}
				phase = Phase.BUILD;
			}
			case BUILD -> {
				if (placer != null) {
					Placer.Result r = placer.tick(level);
					if (r == Placer.Result.WORKING) return Status.RUNNING;
					if (r == Placer.Result.CANT) {
						// try it again later (after the blocks around it are in); give up on that one block after three tries
						BlockPos t = placer.target;
						int n = tries.merge(t, 1, Integer::sum);
						opennpc.OpenNpc.LOG.info("[Open NPC] couldn't place at {} (try {}): {}", t, n, placer.why);
						placer = null;
						if (n >= 3) {
							if (t.equals(doorCell())) return fail("couldn't hang the door");
							build.removeIf(o -> o.pos().equals(t));
							skipped++;
							if (skipped > 6) return fail("couldn't get to too many spots");
						}
						else build.replaceAll(o -> o.pos().equals(t) ? new Op(o.pos(), o.place(), o.layer() + 1, o.material(), o.facing()) : o);
						return Status.RUNNING;
					}
					build.removeIf(o -> o.pos().equals(placer.target));
					placer = null;
					placed++;
					if (!clear.isEmpty()) { phase = Phase.CLEAR; }
					return Status.RUNNING;
				}
				if (build.isEmpty()) { phase = Phase.FINISH; return Status.RUNNING; }
				int layer = build.stream().mapToInt(Op::layer).min().getAsInt();
				Op next = nearest(build, layer);
				if (next.material() == DOORS) {
					// the door last, hung from outside: first she steps out through the doorway
					net.minecraft.world.phys.AABB inside = new net.minecraft.world.phys.AABB(Vec3.atLowerCornerOf(origin), Vec3.atLowerCornerOf(origin.offset(SIZE, HEIGHT, SIZE)));
					if (inside.contains(c.position())) {
						Vec3 out = Vec3.atBottomCenterOf(doorCell().relative(doorSide, 2));
						c.walkTo(out, 1.0);
						if (c.stuckFor() > 200) return fail("couldn't get out of the house to hang the door");
						return Status.RUNNING;
					}
					placer = new Placer(c, next.pos(), next.material(), next.facing());
					placer.avoid = inside;
					return Status.RUNNING;
				}
				placer = new Placer(c, next.pos(), next.material(), next.facing());
			}
			case FINISH -> {
				ServerPlayer o = c.owner();
				return done("built a small wooden house" + (o == null ? "" : " " + Math.round(Math.sqrt(origin.offset(2, 0, 2).distSqr(o.blockPosition()))) + " blocks from " + o.getGameProfile().name()) + (skipped > 0 ? " (" + skipped + " blocks short)" : ""));
			}
		}
		return Status.RUNNING;
	}

	private @Nullable Op nearest(List<Op> ops, int layer) {
		return ops.stream().filter(o -> layer < 0 || o.layer() == layer)
			.min(Comparator.comparingDouble(o -> Vec3.atCenterOf(o.pos()).distanceToSqr(c.position()))).orElse(null);
	}

	private int planksNeeded() {
		int walls = 0;
		for (Op o : build) if (o.material() != DOORS) walls++;
		return walls;
	}

	// ---------------------------------------------------------------- where

	/** A level spot of natural ground near the owner (or her), with nothing built, no trees and no water on it. */
	private boolean findSite(ServerLevel level) {
		ServerPlayer o = c.owner();
		BlockPos around = o != null && o.level() == level ? o.blockPosition() : c.blockPosition();
		BlockPos best = null;
		int bestY = 0;
		double bestScore = Double.MAX_VALUE;
		int[] why = new int[5];   // (uneven, not natural ground or water, something in the way, the owner there)
		for (int r = 6; r <= 14; r += 2) {
			for (int a = 0; a < 360; a += 20) {
				int cx = around.getX() + (int) Math.round(Math.cos(Math.toRadians(a)) * r);
				int cz = around.getZ() + (int) Math.round(Math.sin(Math.toRadians(a)) * r);
				int gy = ground(level, cx, cz);
				int bumps = 0;
				boolean ok = true;
				for (int dx = -3; dx <= 3 && ok; dx++) for (int dz = -3; dz <= 3 && ok; dz++) {
					int x = cx + dx, z = cz + dz;
					int y = ground(level, x, z);
					if (Math.abs(y - gy) > 1) { ok = false; why[0]++; break; }
					bumps += Math.abs(y - gy);
					BlockPos top = new BlockPos(x, y, z);
					if (!naturalGround(level.getBlockState(top)) || !level.getFluidState(top.above()).isEmpty()) { ok = false; why[1]++; break; }
					for (int h = 1; h <= HEIGHT + 2; h++) {
						BlockState s = level.getBlockState(new BlockPos(x, gy + h, z));
						// (open sky over the whole spot: overhanging leaves would block where she has to stand to build)
						if (!s.isAir() && !plant(s)) { ok = false; why[2]++; break; }
						if (!level.getFluidState(new BlockPos(x, gy + h, z)).isEmpty()) { ok = false; break; }
					}
					if (o != null && Math.abs(x - o.getBlockX()) <= 1 && Math.abs(z - o.getBlockZ()) <= 1) ok = false;
				}
				if (!ok) continue;
				double score = bumps * 3 + Math.abs(r - 8);
				if (score < bestScore) { bestScore = score; best = new BlockPos(cx, 0, cz); bestY = gy; }
			}
		}
		if (best == null) {
			opennpc.OpenNpc.LOG.info("[Open NPC] no house spot around {}: uneven {}, not ground {}, in the way {}", around, why[0], why[1], why[2]);
			return false;
		}
		origin = new BlockPos(best.getX() - 2, bestY + 1, best.getZ() - 2);
		// the door faces the owner (or her, when he's not around)
		double dx = around.getX() + 0.5 - (origin.getX() + 2.5), dz = around.getZ() + 0.5 - (origin.getZ() + 2.5);
		doorSide = Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? Direction.EAST : Direction.WEST) : (dz > 0 ? Direction.SOUTH : Direction.NORTH);
		return true;
	}

	/** The y of the top ground block (not plants, not leaves). */
	private static int ground(ServerLevel level, int x, int z) {
		int y = level.getHeight(Heightmap.Types.MOTION_BLOCKING_NO_LEAVES, x, z) - 1;
		while (y > level.getMinY() && plant(level.getBlockState(new BlockPos(x, y, z)))) y--;
		return y;
	}

	static boolean naturalGround(BlockState s) {
		return s.is(BlockTags.DIRT) || s.is(BlockTags.SAND) || s.is(BlockTags.BASE_STONE_OVERWORLD)
			|| s.is(net.minecraft.world.level.block.Blocks.GRASS_BLOCK) || s.is(net.minecraft.world.level.block.Blocks.PODZOL)
			|| s.is(net.minecraft.world.level.block.Blocks.MYCELIUM) || s.is(net.minecraft.world.level.block.Blocks.COARSE_DIRT)
			|| s.is(net.minecraft.world.level.block.Blocks.DIRT) || s.is(net.minecraft.world.level.block.Blocks.ROOTED_DIRT)
			|| s.is(net.minecraft.world.level.block.Blocks.MUD) || s.is(net.minecraft.world.level.block.Blocks.MOSS_BLOCK)
			|| s.is(net.minecraft.world.level.block.Blocks.GRAVEL) || s.is(net.minecraft.world.level.block.Blocks.CLAY)
			|| s.is(net.minecraft.world.level.block.Blocks.SNOW_BLOCK);
	}

	static boolean plant(BlockState s) {
		return s.is(BlockTags.REPLACEABLE) || s.is(BlockTags.FLOWERS) || s.is(BlockTags.SAPLINGS) || s.is(net.minecraft.world.level.block.Blocks.SNOW);
	}

	// ---------------------------------------------------------------- what

	private void plan(ServerLevel level) {
		BlockPos o = origin;
		int y0 = o.getY();
		for (int dx = 0; dx < SIZE; dx++) for (int dz = 0; dz < SIZE; dz++) {
			BlockPos floor = o.offset(dx, -1, dz);
			// dips: fill them; bumps and plants inside the house: clear them
			if (!level.getBlockState(floor).isFaceSturdy(level, floor, Direction.UP)) clear.add(new Op(floor, true, -1, FILL, Direction.NORTH));
			for (int h = 0; h <= HEIGHT; h++) {
				BlockPos p = o.offset(dx, h, dz);
				BlockState s = level.getBlockState(p);
				if (!s.isAir()) clear.add(new Op(p, false, -1, x -> false, Direction.NORTH));
			}
		}
		BlockPos door = doorCell();
		for (int h = 0; h < HEIGHT; h++) {
			for (int dx = 0; dx < SIZE; dx++) for (int dz = 0; dz < SIZE; dz++) {
				boolean edge = dx == 0 || dz == 0 || dx == SIZE - 1 || dz == SIZE - 1;
				if (!edge) continue;
				BlockPos p = o.offset(dx, h, dz);
				if (p.getX() == door.getX() && p.getZ() == door.getZ() && h < 2) continue;   // the doorway
				boolean corner = (dx == 0 || dx == SIZE - 1) && (dz == 0 || dz == SIZE - 1);
				if (h == 1 && !corner && isWindow(dx, dz)) continue;                          // windows
				Predicate<ItemStack> m = corner ? s -> s.is(ItemTags.LOGS) || s.is(ItemTags.PLANKS) : PLANKS;
				build.add(new Op(p, true, h, corner ? cornerMaterial() : m, Direction.NORTH));
			}
		}
		// the roof: the edge first, then in toward the middle
		for (int dx = 0; dx < SIZE; dx++) for (int dz = 0; dz < SIZE; dz++) {
			int ring = Math.min(Math.min(dx, dz), Math.min(SIZE - 1 - dx, SIZE - 1 - dz));
			build.add(new Op(o.offset(dx, HEIGHT, dz), true, HEIGHT + ring, PLANKS, Direction.NORTH));
		}
		build.add(new Op(door, true, 99, DOORS, doorSide));
	}

	private Predicate<ItemStack> cornerMaterial() {
		return s -> Boolean.TRUE.equals(logCorners) && c.count(LOGS) > 0 ? s.is(ItemTags.LOGS) : s.is(ItemTags.PLANKS);
	}

	private boolean isCorner(BlockPos p) {
		int dx = p.getX() - origin.getX(), dz = p.getZ() - origin.getZ();
		return (dx == 0 || dx == SIZE - 1) && (dz == 0 || dz == SIZE - 1) && p.getY() < origin.getY() + HEIGHT;
	}

	private BlockPos doorCell() {
		int mid = SIZE / 2;
		return switch (doorSide) {
			case NORTH -> origin.offset(mid, 0, 0);
			case SOUTH -> origin.offset(mid, 0, SIZE - 1);
			case WEST -> origin.offset(0, 0, mid);
			default -> origin.offset(SIZE - 1, 0, mid);
		};
	}

	/** Window openings in the middle of the two walls beside the door's. */
	private boolean isWindow(int dx, int dz) {
		int mid = SIZE / 2;
		boolean doorOnX = doorSide == Direction.EAST || doorSide == Direction.WEST;
		return doorOnX ? (dx == mid && (dz == 0 || dz == SIZE - 1)) : (dz == mid && (dx == 0 || dx == SIZE - 1));
	}

	/** oak_log -> oak_planks, stripped_birch_log -> birch_planks, crimson_stem -> crimson_planks. */
	static @Nullable Item planksFor(Item log) {
		String id = BuiltInRegistries.ITEM.getKey(log).getPath().replaceFirst("^stripped_", "").replaceFirst("_(log|wood|stem|hyphae)$", "_planks");
		return BuiltInRegistries.ITEM.getOptional(Identifier.withDefaultNamespace(id)).orElse(null);
	}

	static Item doorFor(Item planks) {
		String id = BuiltInRegistries.ITEM.getKey(planks).getPath().replaceFirst("_planks$", "_door");
		return BuiltInRegistries.ITEM.getOptional(Identifier.withDefaultNamespace(id)).orElse(Items.OAK_DOOR);
	}

	@Override
	public void cancel(ServerLevel level) {
		if (sub != null) sub.cancel(level);
		if (breaker != null) breaker.clear(level);
	}
}
