package opennpc.jobs;

import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.sounds.SoundEvents;
import net.minecraft.sounds.SoundSource;
import net.minecraft.tags.ItemTags;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.phys.Vec3;
import opennpc.entity.CompanionEntity;
import org.jspecify.annotations.Nullable;

/**
 * Crafts something from what she carries, with the game's recipes (logs into planks, planks into sticks, and so on).
 * Small recipes she makes in her hands; big ones need a crafting table: she uses one nearby, or sets down her own (making
 * it first if she has to) and picks it back up after. With no wood at all for a wooden thing, she chops some first.
 */
public final class CraftJob extends Work {
	private enum Phase { PLAN, WOOD, TABLE, CRAFT, PACK, COLLECT, GIVE }

	private final Item item;
	private final int n;
	private final boolean handOver;
	private Phase phase = Phase.PLAN;
	private Crafter.Plan plan;
	private int stepAt = 0, craftTicks = 0, have0 = 0;
	private boolean triedWood = false, placed = false;
	private @Nullable String failAfterPacking;
	private @Nullable BlockPos table;
	private @Nullable Work sub;
	private @Nullable Breaker packUp;
	private @Nullable Collect collect;
	private @Nullable Give give;

	public CraftJob(CompanionEntity c, boolean byPlayer, Item item, int n, boolean handOver) {
		super(c, byPlayer);
		this.item = item;
		this.n = Math.max(1, Math.min(64, n));
		this.handOver = handOver;
	}

	@Override
	public String label() { return "crafting " + Crafter.name(item); }

	@Override
	protected Status step(ServerLevel level) {
		if (ticks > 20 * 60 * 5) return fail("took too long");
		switch (phase) {
			case PLAN -> {
				have0 = c.countItem(item);
				plan = Crafter.plan(level, c.bag(), item, have0 + n);
				// a big recipe and no table around or in her bag: the table's wood counts too
				if (plan.ok() && plan.needsTable() && table == null && nearbyTable(level) == null && c.countItem(Items.CRAFTING_TABLE) == 0) {
					Crafter.Plan t = Crafter.plan(level, c.bag(), Items.CRAFTING_TABLE, 1);
					Crafter.Plan rest = t.ok() ? Crafter.plan(level, Crafter.after(c.bag(), t.steps()), item, have0 + n) : t;
					if (!rest.ok()) plan = new Crafter.Plan(List.of(), rest.missing());
				}
				if (!plan.ok()) {
					if (!Crafter.knows(level, item)) return fail("there's no crafting recipe for " + Crafter.name(item));
					if (!triedWood && woody(plan.missing())) {
						triedWood = true;
						sub = new GatherWood(c, byPlayer, 3, "", false);
						phase = Phase.WOOD;
						return Status.RUNNING;
					}
					return fail(plan.missing());
				}
				phase = plan.needsTable() ? Phase.TABLE : Phase.CRAFT;
			}
			case WOOD -> {
				Status s = sub.tick(level);
				if (s == Status.RUNNING) return s;
				if (s == Status.FAILED) return fail("needs wood: " + sub.reason);
				sub = null;
				phase = Phase.PLAN;
			}
			case TABLE -> {
				if (table == null) {
					table = nearbyTable(level);
					if (table == null) {
						if (c.countItem(Items.CRAFTING_TABLE) == 0) {
							Crafter.Plan t = Crafter.plan(level, c.bag(), Items.CRAFTING_TABLE, 1);
							if (!t.ok()) return fail("needs a crafting table: " + t.missing());
							if (!apply(t.steps())) return fail("lost track of the wood for a crafting table");
						}
						table = placeTable(level);
						if (table == null) return fail("no room to set down a crafting table");
						placed = true;
						// (the table used up planks: plan the rest again from what's left)
						plan = Crafter.plan(level, c.bag(), item, have0 + n);
						if (!plan.ok()) return failPacking(plan.missing());
					}
				}
				Vec3 at = Vec3.atCenterOf(table);
				if (c.position().distanceTo(at) > 3.2) {
					c.walkTo(at, 1.0);
					if (c.stuckFor() > 120) return fail("couldn't get to the crafting table");
					return Status.RUNNING;
				}
				c.stopWalking();
				phase = Phase.CRAFT;
			}
			case CRAFT -> {
				if (table != null) c.getLookControl().setLookAt(table.getX() + 0.5, table.getY() + 0.8, table.getZ() + 0.5, 20.0F, 40.0F);
				if (table != null && !level.getBlockState(table).is(Blocks.CRAFTING_TABLE)) return fail("her crafting table is gone");
				if (stepAt >= plan.steps().size()) {
					phase = placed ? Phase.PACK : Phase.GIVE;
					return Status.RUNNING;
				}
				craftTicks++;
				if (craftTicks % 6 == 1) c.swingArm();
				if (craftTicks < 12) return Status.RUNNING;
				craftTicks = 0;
				if (!apply(List.of(plan.steps().get(stepAt)))) return failPacking("didn't have what the recipe needs after all");
				level.playSound(null, c.blockPosition(), table != null ? SoundEvents.UI_CARTOGRAPHY_TABLE_TAKE_RESULT : SoundEvents.ITEM_PICKUP, SoundSource.NEUTRAL, 0.5F, 1.0F);
				stepAt++;
			}
			case PACK -> {
				if (packUp == null) packUp = new Breaker(c, table);
				Breaker.Result r = packUp.tick(level);
				if (r == Breaker.Result.WORKING) return Status.RUNNING;
				collect = new Collect(c, this::wants, 5);
				phase = Phase.COLLECT;
			}
			case COLLECT -> {
				if (collect.tick(level)) return Status.RUNNING;
				if (failAfterPacking != null) return fail(failAfterPacking);
				phase = Phase.GIVE;
			}
			case GIVE -> {
				int made = c.countItem(item) - have0;
				if (!handOver || c.owner() == null) return done("made " + made + " " + Crafter.name(item));
				if (give == null) give = new Give(c, byPlayer, s -> s.is(item), made, Crafter.name(item));
				Status s = give.tick(level);
				if (s == Status.RUNNING) return s;
				return s == Status.DONE ? done(give.result) : fail(give.reason);
			}
		}
		return Status.RUNNING;
	}

	/** Gives up, but packs up the table she set down first. */
	private Status failPacking(String why) {
		if (!placed || table == null) return fail(why);
		failAfterPacking = why;
		phase = Phase.PACK;
		return Status.RUNNING;
	}

	/** Does the plan's steps on her real bag: takes the ingredients, adds what they make. */
	private boolean apply(List<Crafter.Step> steps) {
		for (Crafter.Step st : steps) {
			for (int t = 0; t < st.times(); t++) {
				for (Item in : st.chosen()) if (c.countItem(in) < 1) return false;
				for (Item in : st.chosen()) c.take(s -> s.is(in), 1);
				c.addToBag(new ItemStack(st.result(), st.yield()));
			}
		}
		return true;
	}

	private static boolean woody(String missing) {
		return missing.matches(".*\\b(planks|stick|log|wood)\\b.*");
	}

	private @Nullable BlockPos nearbyTable(ServerLevel level) {
		BlockPos me = c.blockPosition();
		for (BlockPos p : Versions.withinManhattan(me, 6, 3, 6)) if (level.getBlockState(p).is(Blocks.CRAFTING_TABLE)) return p.immutable();
		return null;
	}

	/** Sets her crafting table down next to her, on solid ground, out of anyone's way. */
	private @Nullable BlockPos placeTable(ServerLevel level) {
		BlockPos me = c.blockPosition();
		var o = c.owner();
		for (int r = 1; r <= 2; r++) for (int dx = -r; dx <= r; dx++) for (int dz = -r; dz <= r; dz++) {
			if (Math.max(Math.abs(dx), Math.abs(dz)) != r) continue;
			for (int dy = 0; dy >= -1; dy--) {
				BlockPos p = me.offset(dx, dy, dz);
				if (!level.getBlockState(p).canBeReplaced() || !level.getFluidState(p).isEmpty()) continue;
				if (!level.getBlockState(p.below()).isFaceSturdy(level, p.below(), net.minecraft.core.Direction.UP)) continue;
				if (o != null && o.getBoundingBox().intersects(new net.minecraft.world.phys.AABB(p))) continue;
				if (c.getBoundingBox().intersects(new net.minecraft.world.phys.AABB(p))) continue;
				if (c.take(s -> s.is(Items.CRAFTING_TABLE), 1).isEmpty()) return null;
				c.getLookControl().setLookAt(p.getX() + 0.5, p.getY() + 0.5, p.getZ() + 0.5, 30.0F, 40.0F);
				c.swingArm();
				level.setBlock(p, Blocks.CRAFTING_TABLE.defaultBlockState(), 3);
				level.playSound(null, p, SoundEvents.WOOD_PLACE, SoundSource.BLOCKS, 1.0F, 0.8F);
				return p.immutable();
			}
		}
		return null;
	}

	@Override
	public boolean wants(ItemEntity e) {
		return super.wants(e) || (table != null && e.getItem().is(Items.CRAFTING_TABLE) && e.position().distanceTo(Vec3.atCenterOf(table)) < 3);
	}

	@Override
	public void cancel(ServerLevel level) {
		if (sub != null) sub.cancel(level);
		if (packUp != null) packUp.clear(level);
	}

	/** True for tools she can make (for "make tools" without a name). */
	public static boolean isTool(ItemStack s) {
		return s.is(ItemTags.PICKAXES) || s.is(ItemTags.AXES) || s.is(ItemTags.SWORDS) || s.is(ItemTags.SHOVELS);
	}
}
