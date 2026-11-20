package opennpc.jobs;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Deque;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.function.Predicate;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.tags.BlockTags;
import net.minecraft.tags.ItemTags;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.LeavesBlock;
import net.minecraft.world.level.block.state.BlockState;
import opennpc.entity.CompanionEntity;
import org.jspecify.annotations.Nullable;

/**
 * Chops trees: finds the nearest real tree (logs with natural leaves on top, so never the logs of a build), walks to
 * it, chops the trunk from the bottom up as high as she can reach, picks up the logs, and goes on to the next tree until
 * she has enough. Then she brings them to the owner (when asked by the owner).
 */
public final class GatherWood extends Work {
	private final int want;
	private final String wood;
	private final boolean handOver;
	private final Predicate<ItemStack> isLog;
	private int start = -1;
	private final Deque<BlockPos> trunk = new ArrayDeque<>();
	private final Set<BlockPos> skip = new HashSet<>();
	private final List<BlockPos> thisTree = new ArrayList<>();   // (the logs of the tree she is on)
	private final Set<BlockPos> walkSkipped = new HashSet<>();   // (trees skipped only because she couldn't walk to them from where she was)
	private boolean cameBack = false;
	private @Nullable Breaker breaker;
	private @Nullable Collect collect;
	private @Nullable Give give;
	private int searchIn = 0;

	public GatherWood(CompanionEntity c, boolean byPlayer, int want, String wood, boolean handOver) {
		super(c, byPlayer);
		this.want = Math.max(1, Math.min(64, want));
		this.wood = wood == null ? "" : wood;
		this.handOver = handOver;
		this.isLog = s -> s.is(ItemTags.LOGS) && (this.wood.isEmpty() || BuiltInRegistries.ITEM.getKey(s.getItem()).getPath().contains(this.wood));
	}

	@Override
	public String label() { return wood.isEmpty() ? "chopping wood" : "chopping " + wood + " wood"; }

	private int got() { return Math.max(0, c.count(isLog) - start); }

	@Override
	public String progress() { return got() + "/" + want + " logs"; }

	@Override
	protected Status step(ServerLevel level) {
		if (start < 0) start = c.count(isLog);
		if (give != null) {
			Status s = give.tick(level);
			if (s == Status.RUNNING) return s;
			return s == Status.DONE ? done(give.result) : fail(give.reason);
		}
		if (got() >= want || ticks > 20 * 60 * 4) {
			if (got() == 0) return fail("ran out of time before finding wood");
			return finish();
		}
		if (collect != null) {
			if (collect.tick(level)) return Status.RUNNING;
			collect = null;
		}
		if (breaker != null) {
			Breaker.Result r = breaker.tick(level);
			if (r == Breaker.Result.WORKING) return Status.RUNNING;
			if (r == Breaker.Result.CANT) {
				skip.add(breaker.target);
				opennpc.OpenNpc.LOG.info("[Open NPC] gave up on the log at {}: {} (she is at {})", breaker.target, breaker.why, c.blockPosition());
				// (no way to walk to it: the rest of this tree is no closer, so the whole tree goes and she looks for another one. On a real
				// hill she spent a minute trying one tree's logs one by one.)
				if (breaker.walkFailed) {
					skip.addAll(trunk);
					skip.addAll(thisTree);
					walkSkipped.addAll(thisTree);
					walkSkipped.add(breaker.target);
					trunk.clear();
					searchIn = 0;
				}
			}
			breaker = null;
			if (trunk.isEmpty()) collect = new Collect(c, this::wants, 8);
			return Status.RUNNING;
		}
		while (!trunk.isEmpty()) {
			BlockPos next = trunk.poll();
			if (level.getBlockState(next).is(BlockTags.LOGS) && !skip.contains(next)) { breaker = new Breaker(c, next); return Status.RUNNING; }
		}
		if (--searchIn > 0) return Status.RUNNING;
		List<BlockPos> tree = findTree(level);
		if (tree.isEmpty() && !walkSkipped.isEmpty() && !cameBack && got() == 0) {
			// (trees all around, and she can't walk to a single one: she's stuck where she is, in a hole say. She comes back to the owner,
			// the way she does when she's stuck far behind them, and looks again from there, once.)
			cameBack = true;
			net.minecraft.server.level.ServerPlayer o = c.owner();
			if (o != null && o.level() == level && c.distanceTo(o) > 6 && c.teleportNear(level, o, 3)) {
				opennpc.OpenNpc.LOG.info("[Open NPC] no tree she can walk to from {}: back to the owner to look again", c.blockPosition());
				skip.removeAll(walkSkipped);
				walkSkipped.clear();
				searchIn = 0;
				return Status.RUNNING;
			}
		}
		if (tree.isEmpty()) {
			if (got() > 0) return finish();
			return fail(wood.isEmpty() ? "no trees around here" : "no " + wood + " trees around here");
		}
		trunk.addAll(tree);
		thisTree.clear();
		thisTree.addAll(tree);
		return Status.RUNNING;
	}

	private Status finish() {
		if (!handOver || c.owner() == null) return done(got() + " logs");
		give = new Give(c, byPlayer, isLog, got(), "logs");
		return Status.RUNNING;
	}

	/** The nearest real tree's logs that she can reach from the ground, lowest first. */
	private List<BlockPos> findTree(ServerLevel level) {
		searchIn = 40;
		BlockPos me = c.blockPosition();
		List<BlockPos> bases = new ArrayList<>();
		BlockPos.MutableBlockPos p = new BlockPos.MutableBlockPos();
		for (int dx = -24; dx <= 24; dx++) {
			for (int dz = -24; dz <= 24; dz++) {
				for (int dy = -6; dy <= 8; dy++) {
					p.set(me.getX() + dx, me.getY() + dy, me.getZ() + dz);
					BlockState s = level.getBlockState(p);
					if (!s.is(BlockTags.LOGS) || skip.contains(p)) continue;
					if (!wood.isEmpty() && !BuiltInRegistries.BLOCK.getKey(s.getBlock()).getPath().contains(wood)) continue;
					if (level.getBlockState(p.below()).is(BlockTags.LOGS)) continue;   // (not the bottom of a trunk)
					bases.add(p.immutable());
				}
			}
		}
		bases.sort(Comparator.comparingDouble(b -> b.distSqr(me)));
		for (BlockPos base : bases) {
			List<BlockPos> logs = trunkFrom(level, base);
			if (logs.isEmpty() || !natural(level, logs)) { skip.add(base); continue; }
			List<BlockPos> reach = new ArrayList<>();
			for (BlockPos l : logs) if (l.getY() <= base.getY() + 5) reach.add(l);
			reach.sort(Comparator.comparingInt(BlockPos::getY));
			if (!reach.isEmpty()) return reach;
		}
		return List.of();
	}

	/** The logs of one tree: connected to the base, within a few blocks of it. */
	private static List<BlockPos> trunkFrom(ServerLevel level, BlockPos base) {
		List<BlockPos> out = new ArrayList<>();
		Deque<BlockPos> todo = new ArrayDeque<>(List.of(base));
		Set<BlockPos> seen = new HashSet<>(List.of(base));
		while (!todo.isEmpty() && out.size() < 48) {
			BlockPos b = todo.poll();
			out.add(b);
			for (int dx = -1; dx <= 1; dx++) for (int dy = 0; dy <= 1; dy++) for (int dz = -1; dz <= 1; dz++) {
				BlockPos n = b.offset(dx, dy, dz);
				if (seen.contains(n) || Math.abs(n.getX() - base.getX()) > 3 || Math.abs(n.getZ() - base.getZ()) > 3) continue;
				seen.add(n);
				if (level.getBlockState(n).is(BlockTags.LOGS)) todo.add(n);
			}
		}
		return out;
	}

	/** A real tree has natural leaves (not ones a player placed) around its top. */
	private static boolean natural(ServerLevel level, List<BlockPos> logs) {
		BlockPos top = logs.stream().max(Comparator.comparingInt(BlockPos::getY)).get();
		for (int dx = -3; dx <= 3; dx++) for (int dy = -2; dy <= 3; dy++) for (int dz = -3; dz <= 3; dz++) {
			BlockState s = level.getBlockState(top.offset(dx, dy, dz));
			if (s.is(BlockTags.LEAVES) && s.hasProperty(LeavesBlock.PERSISTENT) && !s.getValue(LeavesBlock.PERSISTENT)) return true;
		}
		return false;
	}

	@Override
	public void cancel(ServerLevel level) {
		if (breaker != null) breaker.clear(level);
	}
}
