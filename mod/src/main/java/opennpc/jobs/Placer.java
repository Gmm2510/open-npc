package opennpc.jobs;

import java.util.function.Predicate;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.item.BlockItem;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.context.DirectionalPlaceContext;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;
import opennpc.entity.CompanionEntity;
import org.jspecify.annotations.Nullable;

/**
 * Places one block the way a player does: walks to a spot within reach (never standing where the block goes), takes the
 * block in hand, looks at the spot, and puts it there with a swing.
 */
public final class Placer {
	public enum Result { WORKING, PLACED, CANT }

	private final CompanionEntity c;
	public final BlockPos target;
	private final Predicate<ItemStack> material;
	private final Direction facing;
	private @Nullable Vec3 stand;
	private int walking = 0, aim = 0;
	public String why = "";
	/** A place she shouldn't stand in while placing this (inside the house, for its door). */
	public @Nullable AABB avoid;

	public Placer(CompanionEntity c, BlockPos target, Predicate<ItemStack> material, Direction facing) {
		this.c = c;
		this.target = target.immutable();
		this.material = material;
		this.facing = facing;
	}

	public Result tick(ServerLevel level) {
		if (!level.getBlockState(target).canBeReplaced()) {
			if (material.test(level.getBlockState(target).getBlock().asItem().getDefaultInstance())) return Result.PLACED;
			why = "something is already there";
			return Result.CANT;
		}
		if (c.count(material) == 0) { why = "ran out of blocks"; return Result.CANT; }
		boolean inTheWay = c.getBoundingBox().intersects(new AABB(target));
		if (inTheWay || !canReach(level, c.position())) {
			if (walking == 0) c.freshStart();
			if (stand == null || walking % 80 == 79) {
				stand = standSpot(level);
				if (stand == null) { why = "no spot to place it from"; return Result.CANT; }
			}
			walking++;
			c.walkTo(stand, 1.0);
			if (walking > 400 || c.stuckFor() > 120) { why = "couldn't get there"; return Result.CANT; }
			aim = 0;
			return Result.WORKING;
		}
		ServerPlayer o = c.owner();
		if (o != null && o.getBoundingBox().intersects(new AABB(target))) return Result.WORKING;   // (he's standing there: wait)
		c.stopWalking();
		Vec3 at = Vec3.atCenterOf(target);
		c.getLookControl().setLookAt(at.x, at.y, at.z, 30.0F, 40.0F);
		if (aim == 0) c.holdMatching(material);
		if (++aim < 4) return Result.WORKING;   // (a moment to aim, like a person)
		ItemStack hand = c.getMainHandItem();
		if (!material.test(hand)) c.holdMatching(material);
		hand = c.getMainHandItem();
		if (!(hand.getItem() instanceof BlockItem bi)) { why = "nothing to place"; return Result.CANT; }
		c.swingArm();
		InteractionResult r = bi.place(new DirectionalPlaceContext(level, target, facing, hand, Direction.UP));
		if (!r.consumesAction()) {
			if (aim > 40) { why = "it wouldn't go there"; return Result.CANT; }
			return Result.WORKING;
		}
		if (hand.isEmpty()) c.setItemSlot(net.minecraft.world.entity.EquipmentSlot.MAINHAND, ItemStack.EMPTY);
		return Result.PLACED;
	}

	private boolean canReach(ServerLevel level, Vec3 feet) {
		Vec3 eye = feet.add(0, c.getEyeHeight(), 0);
		Vec3 at = Vec3.atCenterOf(target);
		if (eye.distanceTo(at) > Breaker.REACH) return false;
		BlockHitResult hit = level.clip(new ClipContext(eye, at, ClipContext.Block.COLLIDER, ClipContext.Fluid.NONE, c));
		// (nothing in the way, or what's hit is right next to the spot: the face she puts it against)
		return hit.getType() == HitResult.Type.MISS || hit.getBlockPos().distManhattan(target) <= 1;
	}

	/** The nearest spot within reach that she can actually walk to (not on top of a wall she just built). */
	private @Nullable Vec3 standSpot(ServerLevel level) {
		java.util.List<Vec3> spots = new java.util.ArrayList<>();
		AABB spot = new AABB(target);
		for (int dx = -3; dx <= 3; dx++) for (int dz = -3; dz <= 3; dz++) for (int dy = -4; dy <= 1; dy++) {
			BlockPos p = target.offset(dx, dy, dz);
			Vec3 at = c.standableAt(level, p);
			if (at == null) continue;
			if (c.getBoundingBox().move(at.subtract(c.position())).intersects(spot)) continue;
			if (avoid != null && avoid.contains(at)) continue;
			Vec3 eye = at.add(0, c.getEyeHeight(), 0);
			if (eye.distanceTo(Vec3.atCenterOf(target)) > Breaker.REACH - 1.0 || !canReach(level, at)) continue;
			spots.add(at);
		}
		spots.sort(java.util.Comparator.comparingDouble(a -> a.distanceToSqr(c.position())));
		int tried = 0;
		for (Vec3 at : spots) {
			if (at.distanceToSqr(c.position()) < 0.3) return at;
			if (++tried > 10) break;
			net.minecraft.world.level.pathfinder.Path path = c.getNavigation().createPath(BlockPos.containing(at), 0);
			if (path != null && path.canReach()) return at;
		}
		return null;
	}
}
