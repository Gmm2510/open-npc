package opennpc.entity;

import net.minecraft.core.BlockPos;
import net.minecraft.tags.BlockTags;
import net.minecraft.util.Mth;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.ai.attributes.Attributes;
import net.minecraft.world.entity.ai.control.MoveControl;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.shapes.VoxelShape;

/**
 * Walking like vanilla, but turning the way a person does: at most 30 degrees a tick instead of snapping round, and a
 * little slower through a sharp turn.
 */
public class SmoothMoveControl extends MoveControl {
	static final float TURN = 30.0F;

	public SmoothMoveControl(Mob mob) {
		super(mob);
	}

	@Override
	public void tick() {
		if (this.operation != Operation.MOVE_TO) {
			super.tick();
			return;
		}
		this.operation = Operation.WAIT;
		double xd = this.wantedX - this.mob.getX();
		double zd = this.wantedZ - this.mob.getZ();
		double yd = this.wantedY - this.mob.getY();
		if (xd * xd + yd * yd + zd * zd < MIN_SPEED_SQR) {
			this.mob.setZza(0.0F);
			return;
		}
		float want = (float) (Mth.atan2(zd, xd) * 180.0F / (float) Math.PI) - 90.0F;
		float left = Math.abs(Mth.wrapDegrees(want - this.mob.getYRot()));
		this.mob.setYRot(this.rotlerp(this.mob.getYRot(), want, TURN));
		double speed = this.speedModifier * this.mob.getAttributeValue(Attributes.MOVEMENT_SPEED);
		if (left > 60.0F) speed *= 0.75;   // through a sharp turn
		this.mob.setSpeed((float) speed);
		BlockPos pos = this.mob.blockPosition();
		BlockState state = this.mob.level().getBlockState(pos);
		VoxelShape shape = state.getCollisionShape(this.mob.level(), pos);
		if (yd > this.mob.maxUpStep() && xd * xd + zd * zd < Math.max(1.0F, this.mob.getBbWidth())
			|| !shape.isEmpty() && this.mob.getY() < shape.max(net.minecraft.core.Direction.Axis.Y) + pos.getY() && !state.is(BlockTags.DOORS) && !state.is(BlockTags.FENCES)) {
			this.mob.getJumpControl().jump();
			this.operation = Operation.JUMPING;
		}
	}
}
