package opennpc.jobs;

import java.util.ArrayDeque;
import java.util.Deque;
import java.util.function.Predicate;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.sounds.SoundEvents;
import net.minecraft.sounds.SoundSource;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.phys.Vec3;
import opennpc.entity.CompanionEntity;

/**
 * Hands the owner items: walks over to them, faces them, and tosses the items to them one stack at a time (only the owner
 * can pick them up for a moment, and she never picks her own tosses back up).
 */
public final class Give extends Work {
	private final Predicate<ItemStack> which;
	private final int n;
	private final String what;
	private Deque<ItemStack> toss;
	private int given = 0, wait = 0;

	public Give(CompanionEntity c, boolean byPlayer, Predicate<ItemStack> which, int n, String what) {
		super(c, byPlayer);
		this.which = which;
		this.n = n <= 0 ? Integer.MAX_VALUE : n;
		this.what = what;
	}

	@Override
	public String label() { return "handing over " + what; }

	@Override
	protected Status step(ServerLevel level) {
		ServerPlayer o = c.owner();
		if (o == null || o.level() != level) return fail("the owner isn't here");
		if (toss == null) {
			toss = new ArrayDeque<>(c.take(which, n));
			if (toss.isEmpty()) return fail("doesn't have any " + what);
		}
		double d = c.distanceTo(o);
		if (d > 3.0) {
			if (ticks > 20 * 60) { putBack(); return fail("couldn't get to the owner"); }
			c.walkTo(o.position(), d > 10 ? 1.13 : 1.0);
			c.getLookControl().setLookAt(o, 10.0F, 40.0F);
			return Status.RUNNING;
		}
		c.stopWalking();
		c.getLookControl().setLookAt(o, 20.0F, 40.0F);
		if (--wait > 0) return Status.RUNNING;
		if (toss.isEmpty()) return done("gave " + o.getGameProfile().name() + " " + given + " " + what);
		ItemStack s = toss.poll();
		Vec3 from = c.getEyePosition().subtract(0, 0.3, 0);
		Vec3 to = o.getEyePosition().subtract(0, 0.6, 0).subtract(from);
		ItemEntity e = new ItemEntity(level, from.x, from.y, from.z, s);
		e.setDeltaMovement(to.normalize().scale(Math.min(0.45, 0.12 + to.length() * 0.09)).add(0, 0.12, 0));
		e.setPickUpDelay(10);
		e.setThrower(c);
		e.setTarget(o.getUUID());
		level.addFreshEntity(e);
		c.swingArm();
		level.playSound(null, c.blockPosition(), SoundEvents.ITEM_PICKUP, SoundSource.NEUTRAL, 0.2F, 0.8F);
		given += s.getCount();
		wait = 6;
		return Status.RUNNING;
	}

	private void putBack() {
		if (toss != null) for (ItemStack s : toss) c.addToBag(s);
		toss = null;
	}

	@Override
	public void cancel(ServerLevel level) { putBack(); }

	@Override
	public boolean wants(ItemEntity item) { return false; }
}
