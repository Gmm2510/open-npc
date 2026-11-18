package opennpc.entity;

import java.util.List;
import java.util.Map;
import java.util.UUID;
import net.minecraft.core.BlockPos;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.util.Mth;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.damagesource.DamageSource;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.PathfinderMob;
import net.minecraft.world.entity.ai.attributes.AttributeSupplier;
import net.minecraft.world.entity.ai.attributes.Attributes;
import net.minecraft.world.entity.ai.goal.FloatGoal;
import net.minecraft.world.entity.ai.goal.OpenDoorGoal;
import net.minecraft.world.entity.ai.navigation.GroundPathNavigation;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.pathfinder.PathType;
import net.minecraft.world.level.pathfinder.WalkNodeEvaluator;
import net.minecraft.world.level.storage.ValueInput;
import net.minecraft.world.level.storage.ValueOutput;
import net.minecraft.world.phys.Vec3;
import opennpc.OpenNpc;
import org.jspecify.annotations.Nullable;

/**
 * The companion's body: a player-sized character with her own skin who follows her owner like a friend would.
 *
 * How she moves (the point is that it never looks robotic):
 *  - She heads for where the owner is now, and a little ahead of where they are going, never to where they were.
 *    The spot is re-picked every half second or so while she walks, so she curves after a moving player.
 *  - She stops at a friendly distance, beside and a bit behind the owner, on the side she is already on (she does not
 *    circle around them), and out of the middle of their view.
 *  - She starts walking only once the owner is properly away (a few steps back and forth don't make her shuffle).
 *  - Speed eases up and down: a walk when close, a brisk walk or a run when far or when the owner runs, slower for the
 *    last steps. Turns are smooth (no snapping to a new direction).
 *  - Standing around, she looks at the owner, now and then glances at something else, and once in a while takes a step.
 *  - Way too far (or stuck far behind): she shows up near the owner, behind them, out of their view.
 */
public class CompanionEntity extends PathfinderMob {
	public enum Mode { FOLLOW, STAY, COME }

	private enum Move { IDLE, WALK, SHIFT }

	public static final double START_BAND = 2.5;   // starts walking once the owner is this much past her gap
	public static final double TELEPORT_DIST = 32;
	public static final double COME_DIST = 2.6;

	private @Nullable UUID ownerId;
	private Mode mode = Mode.FOLLOW;
	private Move move = Move.IDLE;
	public double followGap = 4;

	private @Nullable Vec3 spot;            // where she is walking to
	private double speedNow = 0;            // the current speed, eased toward the wanted one
	private int repathIn = 0;
	private Vec3 ownerLast = Vec3.ZERO;     // for the owner's speed
	private Vec3 ownerVel = Vec3.ZERO;      // smoothed, blocks per tick
	private int glanceTicks = 0, nextGlanceIn = 60;
	private @Nullable Vec3 glanceAt;
	private int shiftIn = 400;
	private int emoteTicks = 0;
	private Vec3 progressAt = Vec3.ZERO;
	private int noProgress = 0;
	private int regenIn = 60;

	public CompanionEntity(EntityType<? extends PathfinderMob> type, Level level) {
		super(type, level);
		this.setPersistenceRequired();
		this.setCanPickUpLoot(false);
		if (this.getNavigation() instanceof GroundPathNavigation nav) {
			nav.setCanOpenDoors(true);
			nav.setCanFloat(true);
		}
		this.setPathfindingMalus(PathType.WATER, 4.0F);
		this.moveControl = new SmoothMoveControl(this);
	}

	public static AttributeSupplier.Builder createAttributes() {
		return Mob.createMobAttributes()
			.add(Attributes.MAX_HEALTH, 20.0)
			.add(Attributes.MOVEMENT_SPEED, 0.32)
			.add(Attributes.FOLLOW_RANGE, 48.0)
			.add(Attributes.STEP_HEIGHT, 0.6);
	}

	@Override
	protected void registerGoals() {
		this.goalSelector.addGoal(0, new FloatGoal(this));
		this.goalSelector.addGoal(1, new OpenDoorGoal(this, true));
	}

	// ---------------------------------------------------------------- who and what

	public void setOwner(@Nullable UUID id) { this.ownerId = id; }
	public @Nullable UUID ownerId() { return ownerId; }
	public Mode mode() { return mode; }

	public void setName(String name) {
		this.setCustomName(Component.literal(name));
		this.setCustomNameVisible(true);
	}

	public @Nullable ServerPlayer owner() {
		if (ownerId == null || !(this.level() instanceof ServerLevel sl)) return null;
		return sl.getServer().getPlayerList().getPlayer(ownerId);
	}

	/** follow: keep close (the default). come: walk over now. stay: wait right here until told otherwise. */
	public void setMode(Mode m) {
		this.mode = m;
		this.spot = null;
		this.repathIn = 0;
		if (m == Mode.STAY) stopWalking();
		if (m == Mode.COME) startWalking();
	}

	/** A little wave (two arm swings) and a hop. */
	public void emote() {
		this.emoteTicks = 24;
	}

	/** What she is doing, in plain words. */
	public String doing() {
		return switch (mode) {
			case STAY -> "staying here";
			case COME -> "coming over";
			case FOLLOW -> move == Move.WALK ? "following, walking to catch up" : "following";
		};
	}

	public boolean isWalking() { return move != Move.IDLE; }
	public double speedNow() { return speedNow; }
	public @Nullable Vec3 spot() { return spot; }

	// ---------------------------------------------------------------- every tick (server)

	@Override
	protected void customServerAiStep(ServerLevel level) {
		super.customServerAiStep(level);
		if (emoteTicks > 0) emoteTick();
		if (this.getHealth() < this.getMaxHealth() && --regenIn <= 0) { this.heal(1.0F); regenIn = 50; }
		ServerPlayer owner = owner();
		if (owner == null || !owner.isAlive() || owner.isSpectator()) {
			stopWalking();
			idleLook(null);
			return;
		}
		Vec3 op = owner.position();
		if (owner.level() == level) {
			Vec3 v = op.subtract(ownerLast);
			if (v.lengthSqr() > 4) v = Vec3.ZERO;   // (a teleport, not walking)
			ownerVel = ownerVel.scale(0.75).add(v.scale(0.25));
		}
		ownerLast = op;
		if (owner.level() != level) {
			if (mode != Mode.STAY && OpenNpc.manager() != null) OpenNpc.manager().bringToOwner(this, owner);
			return;
		}
		double dist = this.distanceTo(owner);
		switch (mode) {
			case STAY -> { stopWalking(); idleLook(owner); }
			case COME -> come(level, owner, dist);
			case FOLLOW -> follow(level, owner, dist);
		}
	}

	private void follow(ServerLevel level, ServerPlayer owner, double dist) {
		double gap = followGap;
		if (dist > TELEPORT_DIST || (move == Move.WALK && noProgress > 160 && dist > 12)) {
			if (teleportNear(level, owner, gap + 2)) return;
		}
		if (move == Move.IDLE) {
			boolean far = dist > gap + START_BAND;
			boolean lost = dist > gap + 1 && this.tickCount % 20 == 0 && !this.hasLineOfSight(owner);
			if (dist < 1.4) {            // the owner walked right into her: step out of the way
				shiftTo(level, owner, Math.max(2.5, gap - 1), 0.8);
				return;
			}
			if (!far && !lost) {
				idleLook(owner);
				maybeShift(level, owner);
				return;
			}
			startWalking();
		}
		if (move == Move.SHIFT) {
			if (dist > gap + START_BAND) { startWalking(); }
			else {
				easeSpeed(0.75);
				if (this.getNavigation().isDone()) stopWalking();
				lookNear(owner, dist);
				return;
			}
		}
		// walking after the owner
		double ownerSpeed = ownerVel.horizontalDistance();
		if (--repathIn <= 0 || spot == null || spot.distanceTo(owner.position()) > gap + 3) {
			spot = pickSpot(level, owner, gap - 0.3 + this.random.nextDouble() * 0.6, true);
			navigateTo(spot != null ? spot : owner.position());
			repathIn = 8 + this.random.nextInt(5);
		}
		double toSpot = spot == null ? dist : horizontal(this.position(), spot);
		easeSpeed(followSpeed(dist - gap, ownerSpeed, toSpot));
		trackProgress();
		boolean ownerStill = ownerSpeed < 0.03;
		if ((ownerStill && dist <= gap + 0.4 && (toSpot < 1.0 || this.getNavigation().isDone()))
			|| (this.getNavigation().isDone() && dist <= gap + 1.0)) {
			stopWalking();
			nextGlanceIn = 30 + this.random.nextInt(60);
		}
		lookNear(owner, dist);
	}

	private void come(ServerLevel level, ServerPlayer owner, double dist) {
		if (dist > TELEPORT_DIST || (noProgress > 120 && dist > 10)) teleportNear(level, owner, 6);
		if (dist <= COME_DIST) {
			stopWalking();
			mode = Mode.FOLLOW;
			nextGlanceIn = 60 + this.random.nextInt(60);
			if (OpenNpc.manager() != null) OpenNpc.manager().event("came_over", Map.of(), false);
			return;
		}
		move = Move.WALK;
		if (--repathIn <= 0 || spot == null || spot.distanceTo(owner.position()) > 3) {
			spot = pickSpot(level, owner, 1.8, false);
			navigateTo(spot != null ? spot : owner.position());
			repathIn = 6 + this.random.nextInt(4);
		}
		double want = dist > 14 ? 1.25 : dist > 6 ? 1.13 : dist > 3.5 ? 1.0 : 0.85;
		easeSpeed(want);
		trackProgress();
		lookNear(owner, dist);
	}

	/** How fast to go, as a multiple of a normal walk. over: how far past her gap the owner is. */
	static double followSpeed(double over, double ownerSpeed, double toSpot) {
		double s;
		if (over > 10) s = 1.25;                 // far behind: run to catch up
		else if (ownerSpeed > 0.25 || over > 5) s = 1.13;   // the owner runs (over 5 blocks a second), or she is well behind: run
		else if (over > 2) s = 1.06;             // a brisk walk
		else s = 1.0;                            // a walk
		if (toSpot < 2.0 && ownerSpeed < 0.05) s = Math.min(s, 0.85);   // the last steps, slower
		return s;
	}

	private void easeSpeed(double want) {
		double step = want > speedNow ? 0.06 : 0.09;
		speedNow = speedNow + Mth.clamp(want - speedNow, -step, step);
		if (speedNow < 0.5 && want >= 0.5) speedNow = 0.5;   // (from standing: a step starts at a slow walk, not at zero)
		this.getNavigation().setSpeedModifier(speedNow);
		this.setSprinting(speedNow > 1.1);
	}

	private void startWalking() {
		move = Move.WALK;
		repathIn = 0;
		noProgress = 0;
		progressAt = this.position();
	}

	private void stopWalking() {
		if (move != Move.IDLE || !this.getNavigation().isDone()) this.getNavigation().stop();
		move = Move.IDLE;
		spot = null;
		speedNow = 0;
		this.setSprinting(false);
	}

	private void navigateTo(Vec3 p) {
		if (!this.getNavigation().moveTo(p.x, p.y, p.z, Math.max(0.5, speedNow))) {
			ServerPlayer o = owner();
			if (o != null) this.getNavigation().moveTo(o, Math.max(0.5, speedNow));
		}
	}

	private void trackProgress() {
		if (this.tickCount % 20 != 0) return;
		if (this.position().distanceTo(progressAt) < 0.5) {
			noProgress += 20;
			if (noProgress % 60 == 0) repathIn = 0;   // try another way
		} else noProgress = 0;
		progressAt = this.position();
	}

	// ---------------------------------------------------------------- where to stand

	/**
	 * A spot about {@code d} blocks from the owner: on the side she is on, behind or beside them, not in the middle of
	 * their view; ahead of them by a little when they move. Null when no good spot is found.
	 */
	private @Nullable Vec3 pickSpot(ServerLevel level, ServerPlayer owner, double d, boolean followLead) {
		Vec3 o = owner.position();
		Vec3 lead = followLead ? ownerVel.scale(12) : Vec3.ZERO;
		if (lead.length() > 4) lead = lead.normalize().scale(4);
		Vec3 c = o.add(lead.x, 0, lead.z);
		boolean moving = ownerVel.horizontalDistance() > 0.03;
		double facing = moving ? Math.atan2(ownerVel.z, ownerVel.x) : Math.toRadians(owner.getYRot() + 90);
		double behind = facing + Math.PI;
		double mine = Math.atan2(this.getZ() - c.z, this.getX() - c.x);
		// how far round from straight behind she may stand: closer behind while they walk, beside them when they stand
		double spread = Math.toRadians(moving ? 50 : 115);
		double off = Mth.clamp(wrap(mine - behind), -spread, spread);
		for (int i = 0; i < 9; i++) {
			double tryOff = off + (i == 0 ? 0 : ((i + 1) / 2) * Math.toRadians(18) * (i % 2 == 0 ? 1 : -1));
			if (Math.abs(tryOff) > Math.toRadians(140)) continue;
			double a = behind + tryOff;
			Vec3 p = standable(level, c.x + Math.cos(a) * d, o.y, c.z + Math.sin(a) * d);
			if (p != null) return p;
		}
		return null;
	}

	/** A place to stand near x, y, z (the ground within a few blocks up or down), or null. */
	private @Nullable Vec3 standable(ServerLevel level, double x, double y, double z) {
		BlockPos base = BlockPos.containing(x, y, z);
		for (int dy : new int[] {0, 1, -1, 2, -2, 3, -3, -4}) {
			BlockPos p = base.above(dy);
			if (WalkNodeEvaluator.getPathTypeStatic(this, p) != PathType.WALKABLE) continue;
			if (!level.noCollision(this, this.getBoundingBox().move(Vec3.atBottomCenterOf(p).subtract(this.position())))) continue;
			return Vec3.atBottomCenterOf(p);
		}
		return null;
	}

	/** Shows up near the owner, behind them and out of their view if it can. */
	public boolean teleportNear(ServerLevel level, ServerPlayer owner, double d) {
		Vec3 o = owner.position();
		double behind = Math.toRadians(owner.getYRot() + 90) + Math.PI;
		for (int i = 0; i < 16; i++) {
			double a = behind + (this.random.nextDouble() - 0.5) * Math.toRadians(i < 10 ? 120 : 300);
			double r = d + this.random.nextDouble() * 2;
			Vec3 p = standable(level, o.x + Math.cos(a) * r, o.y, o.z + Math.sin(a) * r);
			if (p == null) continue;
			this.snapTo(p.x, p.y, p.z, (float) Math.toDegrees(Math.atan2(o.z - p.z, o.x - p.x)) - 90, 0);
			this.getNavigation().stop();
			move = Move.IDLE;
			spot = null;
			speedNow = 0;
			noProgress = 0;
			return true;
		}
		return false;
	}

	// ---------------------------------------------------------------- standing around

	private void maybeShift(ServerLevel level, ServerPlayer owner) {
		if (--shiftIn > 0) return;
		shiftIn = 500 + this.random.nextInt(500);
		if (this.random.nextFloat() < 0.45) shiftTo(level, owner, followGap - 0.5 + this.random.nextDouble(), 0.75);
	}

	private void shiftTo(ServerLevel level, ServerPlayer owner, double d, double speed) {
		Vec3 p = pickSpot(level, owner, d, false);
		if (p == null || horizontal(p, this.position()) < 0.8) return;
		move = Move.SHIFT;
		speedNow = speed;
		spot = p;
		this.getNavigation().moveTo(p.x, p.y, p.z, speed);
	}

	/** Head: on the owner while they are near, with now and then a glance at something else. */
	private void lookNear(ServerPlayer owner, double dist) {
		if (dist < followGap + 5) this.getLookControl().setLookAt(owner, 10.0F, 40.0F);
	}

	private void idleLook(@Nullable ServerPlayer owner) {
		if (glanceTicks > 0) {
			glanceTicks--;
			if (glanceAt != null) this.getLookControl().setLookAt(glanceAt.x, glanceAt.y, glanceAt.z, 6.0F, 30.0F);
			return;
		}
		if (owner != null && this.distanceTo(owner) < 24) this.getLookControl().setLookAt(owner, 8.0F, 40.0F);
		if (--nextGlanceIn > 0) return;
		nextGlanceIn = 90 + this.random.nextInt(170);
		glanceTicks = 25 + this.random.nextInt(45);
		List<LivingEntity> near = this.level().getEntitiesOfClass(LivingEntity.class, this.getBoundingBox().inflate(10), e -> e != this && e != owner && e.isAlive());
		if (!near.isEmpty() && this.random.nextFloat() < 0.6) {
			LivingEntity e = near.get(this.random.nextInt(near.size()));
			glanceAt = e.getEyePosition();
		} else {
			double a = Math.toRadians(this.yBodyRot + 90 + (this.random.nextDouble() - 0.5) * 220);
			double r = 4 + this.random.nextDouble() * 8;
			glanceAt = new Vec3(this.getX() + Math.cos(a) * r, this.getEyeY() + (this.random.nextDouble() - 0.6) * 3, this.getZ() + Math.sin(a) * r);
		}
	}

	private void emoteTick() {
		emoteTicks--;
		if (emoteTicks == 22 || emoteTicks == 14) this.swing(InteractionHand.MAIN_HAND);
		if (emoteTicks == 8 && this.onGround()) this.getJumpControl().jump();
	}

	// ---------------------------------------------------------------- body things

	@Override
	public boolean hurtServer(ServerLevel level, DamageSource source, float damage) {
		Entity by = source.getEntity();
		if (by != null && ownerId != null && ownerId.equals(by.getUUID())) return false;   // the owner's stray hits don't hurt her
		boolean hurt = super.hurtServer(level, source, damage);
		if (hurt && OpenNpc.manager() != null && this.isAlive()) {
			OpenNpc.manager().hurt(this, source);
		}
		return hurt;
	}

	@Override
	public void die(DamageSource source) {
		super.die(source);
		if (!this.level().isClientSide() && OpenNpc.manager() != null) OpenNpc.manager().died(this, source);
	}

	@Override
	public boolean removeWhenFarAway(double distSqr) { return false; }

	@Override
	public boolean requiresCustomPersistence() { return true; }

	@Override
	protected void addAdditionalSaveData(ValueOutput output) {
		super.addAdditionalSaveData(output);
		if (ownerId != null) output.putString("open_npc_owner", ownerId.toString());
		output.putString("open_npc_mode", mode == Mode.COME ? Mode.FOLLOW.name() : mode.name());
	}

	@Override
	protected void readAdditionalSaveData(ValueInput input) {
		super.readAdditionalSaveData(input);
		String o = input.getStringOr("open_npc_owner", "");
		try { ownerId = o.isEmpty() ? null : UUID.fromString(o); } catch (IllegalArgumentException e) { ownerId = null; }
		try { mode = Mode.valueOf(input.getStringOr("open_npc_mode", "FOLLOW")); } catch (IllegalArgumentException e) { mode = Mode.FOLLOW; }
	}

	// ---------------------------------------------------------------- small helpers

	static double horizontal(Vec3 a, Vec3 b) {
		double dx = a.x - b.x, dz = a.z - b.z;
		return Math.sqrt(dx * dx + dz * dz);
	}

	static double wrap(double a) {
		while (a > Math.PI) a -= 2 * Math.PI;
		while (a < -Math.PI) a += 2 * Math.PI;
		return a;
	}
}
