package opennpc.jobs;

import java.util.Comparator;
import java.util.List;
import java.util.function.Predicate;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.item.ItemEntity;
import opennpc.entity.CompanionEntity;

/** Walks over the items a job wants (what she just broke), so they land in her bag. */
final class Collect {
	private final CompanionEntity c;
	private final Predicate<ItemEntity> wanted;
	private final double radius;
	private int ticks = 0, idle = 0;

	Collect(CompanionEntity c, Predicate<ItemEntity> wanted, double radius) {
		this.c = c;
		this.wanted = wanted;
		this.radius = radius;
	}

	/** True while there is still something to pick up (gives up after a while). */
	boolean tick(ServerLevel level) {
		ticks++;
		List<ItemEntity> items = level.getEntitiesOfClass(ItemEntity.class, c.getBoundingBox().inflate(radius, 4, radius), e -> e.isAlive() && wanted.test(e));
		if (items.isEmpty()) {
			// (drops pop out a moment after a block breaks: wait a few ticks before calling it done)
			if (++idle > 12) { c.stopWalking(); return false; }
			return true;
		}
		idle = 0;
		if (ticks > 240) { c.stopWalking(); return false; }
		ItemEntity near = items.stream().min(Comparator.comparingDouble(c::distanceToSqr)).get();
		c.walkTo(near.position(), 1.0);
		c.getLookControl().setLookAt(near.getX(), near.getY(), near.getZ(), 20.0F, 40.0F);
		return true;
	}
}
