package opennpc.jobs;

import java.util.Comparator;
import java.util.List;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.monster.Enemy;
import net.minecraft.world.phys.Vec3;
import opennpc.entity.CompanionEntity;
import org.jspecify.annotations.Nullable;

/**
 * Fights hostile mobs with her best weapon: the nearest one (attack), one that went for her (defend), or any that come
 * near the owner for a while (guard). Never creepers up close (they blow up) and never endermen (they're no threat
 * unless looked at); never players or animals.
 */
public final class Fight extends Work {
	private final int lastsTicks;
	private final boolean guard;
	private @Nullable LivingEntity target;
	private int cooldown = 0, idle = 0, kills = 0;
	private final java.util.Set<Integer> counted = new java.util.HashSet<>();

	public Fight(CompanionEntity c, boolean byPlayer, @Nullable LivingEntity first, boolean guard) {
		super(c, byPlayer);
		this.guard = guard;
		this.target = first;
		this.lastsTicks = guard ? 20 * 120 : 20 * 40;
	}

	@Override
	public String label() { return guard ? "guarding" : "fighting"; }

	@Override
	public String progress() { return kills > 0 ? kills + " down" : ""; }

	public static boolean fightable(LivingEntity e) {
		return e instanceof Enemy && e.isAlive() && e.getType() != EntityType.CREEPER && e.getType() != EntityType.ENDERMAN;
	}

	@Override
	protected Status step(ServerLevel level) {
		if (ticks == 1) c.holdWeapon();
		if (cooldown > 0) cooldown--;
		if (target != null && (!target.isAlive() || target.isRemoved())) {
			if (target.isDeadOrDying() && counted.add(target.getId())) kills++;
			target = null;
		}
		ServerPlayer o = c.owner();
		if (target == null) {
			target = nearest(level, o);
			if (target == null) {
				idle++;
				if (!guard && idle > 40) return kills > 0 ? done("took down " + kills) : done(ticks < 50 ? "nothing to fight nearby" : "all clear");
				if (guard) c.followOwnerStep(level);
				if (ticks > lastsTicks) return done(kills > 0 ? "took down " + kills : "all quiet");
				return Status.RUNNING;
			}
		}
		idle = 0;
		// badly hurt: back off to the owner (a friend doesn't fight to the death)
		if (c.getHealth() < 7) return done(kills > 0 ? "took down " + kills + ", then backed off hurt" : "backed off, hurt");
		if (ticks > lastsTicks && !guard) return done("took down " + kills);
		if (guard && ticks > lastsTicks) return done(kills > 0 ? "took down " + kills : "all quiet");
		// too far from the owner: let it go
		if (target.distanceTo(c) > 20 || (o != null && target.distanceTo(o) > 16)) { target = null; return Status.RUNNING; }
		c.getLookControl().setLookAt(target, 30.0F, 30.0F);
		if (c.isWithinMeleeAttackRange(target) && c.hasLineOfSight(target)) {
			c.stopWalking();
			if (cooldown == 0) {
				c.swingArm();
				c.doHurtTarget(level, target);
				cooldown = 12;
			}
		} else {
			c.walkTo(target.position(), 1.2);
		}
		return Status.RUNNING;
	}

	private @Nullable LivingEntity nearest(ServerLevel level, @Nullable ServerPlayer o) {
		// only monsters near the owner (or near her when he's away)
		Vec3 centre = o != null && o.level() == level ? o.position() : c.position();
		double r = 12;
		List<LivingEntity> l = level.getEntitiesOfClass(LivingEntity.class, new net.minecraft.world.phys.AABB(centre, centre).inflate(r, 6, r), Fight::fightable);
		return l.stream().filter(c::hasLineOfSight).min(Comparator.comparingDouble(e -> e.distanceToSqr(centre))).orElse(null);
	}

	@Override
	public boolean wants(ItemEntity item) { return false; }
}
