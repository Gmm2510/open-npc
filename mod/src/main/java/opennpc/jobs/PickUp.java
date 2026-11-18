package opennpc.jobs;

import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.item.ItemEntity;
import opennpc.entity.CompanionEntity;

/** Picks up the items lying around her (not ones she just handed over). */
public final class PickUp extends Work {
	private final Collect collect;
	private int before = -1;

	public PickUp(CompanionEntity c, boolean byPlayer) {
		super(c, byPlayer);
		this.collect = new Collect(c, this::wants, 10);
	}

	@Override
	public String label() { return "picking things up"; }

	@Override
	protected Status step(ServerLevel level) {
		if (before < 0) before = c.count(s -> true);
		if (collect.tick(level)) return Status.RUNNING;
		int got = c.count(s -> true) - before;
		return got > 0 ? done("picked up " + got + " items") : done("nothing to pick up nearby");
	}

	@Override
	public boolean wants(ItemEntity item) {
		return !c.threw(item);
	}
}
