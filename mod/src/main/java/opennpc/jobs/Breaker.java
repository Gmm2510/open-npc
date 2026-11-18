package opennpc.jobs;

import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.sounds.SoundSource;
import net.minecraft.util.Mth;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.SoundType;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;
import opennpc.entity.CompanionEntity;
import org.jspecify.annotations.Nullable;

/**
 * Breaks one block the way a player does: walks to a spot where she can reach and see it, looks at it, swings while the
 * cracks spread (as long as the block's hardness and her tool say), and then it breaks and drops what it drops.
 */
public final class Breaker {
	public enum Result { WORKING, BROKEN, CANT }

	public static final double REACH = 4.4;

	private final CompanionEntity c;
	public final BlockPos target;
	private @Nullable Vec3 stand;
	private int progress = 0, need = -1, walking = 0, lastStage = -1;
	public String why = "";
	// natural leaves in the way (around a low tree): she knocks them out first, the way a player would
	private @Nullable Breaker clearing;
	private final int depth;
	private int peeled = 0;

	public Breaker(CompanionEntity c, BlockPos target) {
		this(c, target, 0);
	}

	private Breaker(CompanionEntity c, BlockPos target, int depth) {
		this.c = c;
		this.target = target.immutable();
		this.depth = depth;
	}

	public Result tick(ServerLevel level) {
		BlockState state = level.getBlockState(target);
		if (state.isAir()) { clear(level); return Result.BROKEN; }
		float hardness = state.getDestroySpeed(level, target);
		if (hardness < 0) { why = "it can't be broken"; return Result.CANT; }
		if (clearing != null) {
			Result r = clearing.tick(level);
			if (r == Result.CANT) { why = "leaves in the way: " + clearing.why; clearing = null; return Result.CANT; }
			if (r == Result.BROKEN) { clearing = null; walking = 0; stand = null; }
			return Result.WORKING;
		}
		if (!canReach(level, c.position())) {
			if (walking == 0) c.freshStart();
			if (stand == null || walking % 80 == 79) {
				stand = standSpot(level);
				// (leaves in the way: knock out the reachable one nearest the block, then look again)
				if (stand == null && depth == 0 && peeled < 30) {
					BlockPos leaf = peelLeaf(level);
					if (leaf != null) { peeled++; clearing = new Breaker(c, leaf, 1); return Result.WORKING; }
				}
				if (stand == null) { why = "no way to get to it"; return Result.CANT; }
			}
			walking++;
			c.walkTo(stand, 1.0);
			if (walking > 400 || c.stuckFor() > 120) {
				var path = c.getNavigation().getPath();
				why = "couldn't get to it (stand " + stand + ", path end " + (path == null ? "none" : path.getEndNode() == null ? "?" : path.getEndNode().asBlockPos()) + ", reach " + (path != null && path.canReach()) + ", walked " + walking + ", stuck " + c.stuckFor() + ")";
				return Result.CANT;
			}
			return Result.WORKING;
		}
		c.stopWalking();
		Vec3 centre = Vec3.atCenterOf(target);
		c.getLookControl().setLookAt(centre.x, centre.y, centre.z, 30.0F, 40.0F);
		if (need < 0) {
			ItemStack tool = c.holdBestFor(state);
			need = ticksToBreak(state, hardness, tool);
		}
		progress++;
		if (progress % 5 == 1) c.swingArm();
		if (progress % 4 == 1) {
			SoundType sound = state.getSoundType();
			level.playSound(null, target, sound.getHitSound(), SoundSource.BLOCKS, (sound.getVolume() + 1.0F) / 8.0F, sound.getPitch() * 0.5F);
		}
		int stage = Mth.clamp((int) (progress * 10.0F / need), 0, 9);
		if (stage != lastStage) { level.destroyBlockProgress(c.getId(), target, stage); lastStage = stage; }
		if (progress < need) return Result.WORKING;
		// broken: drops as if her tool broke it
		ItemStack tool = c.getMainHandItem();
		boolean drops = !state.requiresCorrectToolForDrops() || tool.isCorrectToolForDrops(state);
		BlockEntity be = level.getBlockEntity(target);
		if (drops) {
			// (the drops come out of the side she hit, toward her, the way she'd reach for them)
			Vec3 eye = c.getEyePosition();
			Direction face = Direction.getApproximateNearest(eye.x - centre.x, eye.y - centre.y, eye.z - centre.z);
			for (ItemStack d : Block.getDrops(state, level, target, be, c, tool)) Block.popResourceFromFace(level, target, face, d);
			state.spawnAfterBreak(level, target, tool, true);
		}
		level.destroyBlock(target, false, c);
		clear(level);
		c.noteBroke(target);
		if (!tool.isEmpty() && tool.isDamageableItem() && hardness > 0) tool.hurtAndBreak(1, c, EquipmentSlot.MAINHAND);
		return Result.BROKEN;
	}

	public void clear(ServerLevel level) {
		if (lastStage >= 0) level.destroyBlockProgress(c.getId(), target, -1);
		lastStage = -1;
		if (clearing != null) clearing.clear(level);
	}

	/** Ticks to break, the way a player's digging speed works out (without enchantments or effects). */
	public static int ticksToBreak(BlockState state, float hardness, ItemStack tool) {
		if (hardness <= 0) return 1;
		float speed = tool.isEmpty() ? 1.0F : Math.max(1.0F, tool.getDestroySpeed(state));
		boolean right = !state.requiresCorrectToolForDrops() || (!tool.isEmpty() && tool.isCorrectToolForDrops(state));
		float perTick = speed / hardness / (right ? 30.0F : 100.0F);
		return Mth.clamp((int) Math.ceil(1.0F / perTick), 1, 400);
	}

	/** From her eyes at `at`, the block is within reach and nothing is in the way. */
	public boolean canReach(ServerLevel level, Vec3 at) {
		return canReach(level, at, REACH);
	}

	private boolean canReach(ServerLevel level, Vec3 at, double reach) {
		Vec3 eye = at.add(0, c.getEyeHeight(), 0);
		Vec3 centre = Vec3.atCenterOf(target);
		if (eye.distanceTo(centre) > reach) return false;
		return sees(level, eye, target);
	}

	/** She can see some side of the block (aims at its middle and at the middle of each side, like a player would). */
	public boolean sees(ServerLevel level, Vec3 eye, BlockPos pos) {
		Vec3 centre = Vec3.atCenterOf(pos);
		if (hits(level, eye, centre, pos)) return true;
		for (Direction d : Direction.values()) {
			Vec3 side = centre.add(d.getStepX() * 0.45, d.getStepY() * 0.45, d.getStepZ() * 0.45);
			// (only sides that face her)
			if ((side.x - centre.x) * (eye.x - centre.x) + (side.y - centre.y) * (eye.y - centre.y) + (side.z - centre.z) * (eye.z - centre.z) <= 0) continue;
			if (hits(level, eye, side, pos)) return true;
		}
		return false;
	}

	private boolean hits(ServerLevel level, Vec3 eye, Vec3 at, BlockPos pos) {
		BlockHitResult hit = level.clip(new ClipContext(eye, at, ClipContext.Block.COLLIDER, ClipContext.Fluid.NONE, c));
		return hit.getType() == HitResult.Type.MISS || hit.getBlockPos().equals(pos);
	}

	/** The nearest place to stand from where she can reach and see the block. */
	private @Nullable Vec3 standSpot(ServerLevel level) {
		Vec3 best = null;
		double bestD = Double.MAX_VALUE;
		for (int dx = -3; dx <= 3; dx++) {
			for (int dz = -3; dz <= 3; dz++) {
				for (int dy = -4; dy <= 2; dy++) {
					if (Math.abs(dx) + Math.abs(dz) == 0 && dy >= -1) continue;
					BlockPos p = target.offset(dx, dy, dz);
					Vec3 at = c.standableAt(level, p);
					// (comfortably within reach, so arriving a little off the middle of the block still reaches)
					if (at == null || !canReach(level, at, REACH - 1.0)) continue;
					double d = at.distanceToSqr(c.position()) + (dy > 0 ? 4 : 0) + at.distanceToSqr(Vec3.atCenterOf(target));
					if (d < bestD) { bestD = d; best = at; }
				}
			}
		}
		return best;
	}

	/** The natural leaves around the block that she can reach and see now, the one nearest the block first. */
	private @Nullable BlockPos peelLeaf(ServerLevel level) {
		java.util.List<BlockPos> found = new java.util.ArrayList<>();
		for (BlockPos p : BlockPos.betweenClosed(target.offset(-3, -1, -3), target.offset(3, 3, 3))) {
			if (naturalLeaves(level.getBlockState(p))) found.add(p.immutable());
		}
		Vec3 centre = Vec3.atCenterOf(target);
		found.sort(java.util.Comparator.comparingDouble(p -> Vec3.atCenterOf(p).distanceToSqr(centre)));
		int checked = 0;
		for (BlockPos p : found) {
			if (++checked > 90) break;
			if (new Breaker(c, p, 1).standSpot(level) != null) return p;
		}
		return null;
	}

	static boolean naturalLeaves(BlockState s) {
		return s.is(net.minecraft.tags.BlockTags.LEAVES) && s.hasProperty(net.minecraft.world.level.block.LeavesBlock.PERSISTENT) && !s.getValue(net.minecraft.world.level.block.LeavesBlock.PERSISTENT);
	}

	/** True when at least one face of the block touches open air (not water or lava): she can see it without digging in. */
	public static boolean showing(ServerLevel level, BlockPos pos) {
		for (Direction d : Direction.values()) {
			BlockPos n = pos.relative(d);
			BlockState s = level.getBlockState(n);
			if (s.isAir() && level.getFluidState(n).isEmpty()) return true;
		}
		return false;
	}
}
