package opennpc.jobs;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.function.Predicate;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.sounds.SoundEvents;
import net.minecraft.sounds.SoundSource;
import net.minecraft.tags.BlockTags;
import net.minecraft.tags.FluidTags;
import net.minecraft.tags.ItemTags;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.item.BlockItem;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.CropBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.Vec3;
import opennpc.entity.CompanionEntity;
import org.jspecify.annotations.Nullable;

/**
 * Makes a small field and plants it: a hoe (she makes a wooden one if she has none), seeds (from her bag, or from the
 * grass around, which drops them now and then), a patch of grass or dirt near water if there's some close, tilled and
 * sown one square at a time. Or (harvest) picks the ripe crops around, collects what drops, and sows again.
 */
public final class Farm extends Work {
	private enum Phase { HOE, SEEDS, SITE, WORK, COLLECT }

	private final boolean harvest;
	private final int want;
	private Phase phase;
	private final List<BlockPos> plots = new ArrayList<>();
	private @Nullable BlockPos at;
	private int aim = 0, sown = 0, picked = 0, grassBroken = 0;
	private final List<BlockPos> harvested = new ArrayList<>();   // the soil under what she picked (to sow again)
	private @Nullable Work sub;
	private @Nullable Breaker breaker;
	private @Nullable Collect collect;
	private @Nullable Vec3 stand;
	private int walking = 0;

	public Farm(CompanionEntity c, boolean byPlayer, int want, boolean harvest) {
		super(c, byPlayer);
		this.want = Math.max(1, Math.min(25, want));
		this.harvest = harvest;
		this.phase = harvest ? Phase.SITE : Phase.HOE;
	}

	@Override
	public String label() { return harvest ? "harvesting" : "planting a field"; }

	@Override
	public String progress() {
		if (sub != null) return "first: " + sub.label();
		return harvest ? picked + " picked" : sown + "/" + want + " planted";
	}

	/** Seeds she can sow: things that plant a crop (wheat seeds, carrots, potatoes, beetroot seeds). */
	static final Predicate<ItemStack> SEEDS = s -> s.getItem() instanceof BlockItem b && b.getBlock() instanceof CropBlock;

	@Override
	protected Status step(ServerLevel level) {
		if (ticks > 20 * 60 * 6) return finish("ran out of time");
		if (sub != null) {
			Status s = sub.tick(level);
			if (s == Status.RUNNING) return s;
			Work w = sub;
			sub = null;
			if (s == Status.FAILED) return fail("needs a hoe: " + w.reason);
			return Status.RUNNING;
		}
		if (collect != null) {
			if (collect.tick(level)) return Status.RUNNING;
			collect = null;
		}
		if (breaker != null) {
			Breaker.Result r = breaker.tick(level);
			if (r == Breaker.Result.WORKING) return Status.RUNNING;
			BlockPos was = breaker.target;
			breaker = null;
			if (phase == Phase.SEEDS) { grassBroken++; collect = new Collect(c, this::wants, 6); }
			if (phase == Phase.WORK && harvest && r == Breaker.Result.BROKEN) { picked++; collect = new Collect(c, this::wants, 6); at = was; harvested.add(was.below()); }
			return Status.RUNNING;
		}
		switch (phase) {
			case HOE -> {
				if (c.count(s -> s.is(ItemTags.HOES)) == 0) { sub = new CraftJob(c, byPlayer, Items.WOODEN_HOE, 1, false); return Status.RUNNING; }
				phase = Phase.SEEDS;
			}
			case SEEDS -> {
				if (c.count(SEEDS) >= want || (c.count(SEEDS) > 0 && grassBroken >= 40)) { phase = Phase.SITE; return Status.RUNNING; }
				if (grassBroken >= 40) return fail("no seeds: she has none and the grass around didn't drop any");
				BlockPos grass = nearestGrass(level);
				if (grass == null) {
					if (c.count(SEEDS) > 0) { phase = Phase.SITE; return Status.RUNNING; }
					return fail("no seeds: she has none and there's no grass around to find some in");
				}
				breaker = new Breaker(c, grass);
			}
			case SITE -> {
				if (harvest) {
					plots.addAll(ripe(level));
					if (plots.isEmpty()) return done("nothing ripe around here yet");
				} else {
					if (!findPlots(level)) return fail("no open grass or dirt near you to make a field");
				}
				phase = Phase.WORK;
			}
			case WORK -> {
				if (harvest) return harvestStep(level);
				return plantStep(level);
			}
			case COLLECT -> { return finish(""); }
		}
		return Status.RUNNING;
	}

	private Status finish(String why) {
		if (harvest) return picked > 0 ? done("picked " + picked + " crops and planted again") : done(why.isEmpty() ? "nothing ripe" : why);
		return sown > 0 ? done("planted " + sown + " " + (sown == 1 ? "square" : "squares") + (why.isEmpty() ? "" : " (" + why + ")")) : fail(why.isEmpty() ? "planted nothing" : why);
	}

	// ---------------------------------------------------------------- planting

	private Status plantStep(ServerLevel level) {
		if (at == null) {
			plots.removeIf(p -> !tillable(level, p) && !emptyFarmland(level, p));
			if (plots.isEmpty() || sown >= want || c.count(SEEDS) == 0) return finish(c.count(SEEDS) == 0 && sown < want ? "out of seeds" : "");
			at = plots.stream().min(Comparator.comparingDouble(p -> p.getCenter().distanceToSqr(c.position()))).get();
			plots.remove(at);
			aim = 0;
			walking = 0;
			stand = null;
			// a plant on top (grass, a flower): break it first
			BlockState above = level.getBlockState(at.above());
			if (!above.isAir()) { breaker = new Breaker(c, at.above()); return Status.RUNNING; }
		}
		if (!near(level, at)) return Status.RUNNING;
		c.getLookControl().setLookAt(at.getX() + 0.5, at.getY() + 1.0, at.getZ() + 0.5, 30.0F, 40.0F);
		if (++aim < 5) return Status.RUNNING;
		if (!level.getBlockState(at).is(Blocks.FARMLAND)) {
			if (!tillable(level, at)) { at = null; return Status.RUNNING; }
			c.holdMatching(s -> s.is(ItemTags.HOES));
			c.swingArm();
			level.setBlock(at, Blocks.FARMLAND.defaultBlockState(), 11);
			level.playSound(null, at, SoundEvents.HOE_TILL, SoundSource.BLOCKS, 1.0F, 1.0F);
			ItemStack hoe = c.getMainHandItem();
			if (hoe.is(ItemTags.HOES)) hoe.hurtAndBreak(1, c, EquipmentSlot.MAINHAND);
			aim = 0;
			return Status.RUNNING;
		}
		if (aim < 10) return Status.RUNNING;
		if (!level.getBlockState(at.above()).isAir()) { at = null; return Status.RUNNING; }
		List<ItemStack> seed = c.take(SEEDS, 1);
		if (seed.isEmpty()) return finish("out of seeds");
		CropBlock crop = (CropBlock) ((BlockItem) seed.get(0).getItem()).getBlock();
		c.swingArm();
		level.setBlock(at.above(), crop.getStateForAge(0), 3);
		level.playSound(null, at, SoundEvents.CROP_PLANTED, SoundSource.BLOCKS, 1.0F, 1.0F);
		sown++;
		at = null;
		return Status.RUNNING;
	}

	/** Walks to within reach of the square; true once she's there. */
	private boolean near(ServerLevel level, BlockPos p) {
		Vec3 target = Vec3.atCenterOf(p.above());
		if (c.getEyePosition().distanceTo(target) <= 3.6 && !c.getBoundingBox().intersects(new net.minecraft.world.phys.AABB(p.above()))) { c.stopWalking(); return true; }
		if (walking == 0) c.freshStart();
		if (stand == null || walking % 80 == 79) {
			stand = null;
			double best = Double.MAX_VALUE;
			for (int dx = -2; dx <= 2; dx++) for (int dz = -2; dz <= 2; dz++) for (int dy = -1; dy <= 2; dy++) {
				if (dx == 0 && dz == 0) continue;
				Vec3 s = c.standableAt(level, p.offset(dx, dy, dz));
				if (s == null || plots.contains(p.offset(dx, dy - 1, dz))) continue;
				if (level.getBlockState(p.offset(dx, dy - 1, dz)).is(Blocks.FARMLAND)) continue;   // (never trample the field)
				double d = s.distanceToSqr(c.position());
				if (d < best) { best = d; stand = s; }
			}
			if (stand == null) { at = null; return false; }
		}
		walking++;
		c.walkTo(stand, 1.0);
		if (walking > 300 || c.stuckFor() > 120) { at = null; }
		return false;
	}

	private static boolean tillable(ServerLevel level, BlockPos p) {
		BlockState s = level.getBlockState(p);
		BlockState above = level.getBlockState(p.above());
		return (s.is(Blocks.GRASS_BLOCK) || s.is(Blocks.DIRT) || s.is(Blocks.DIRT_PATH) || s.is(Blocks.COARSE_DIRT))
			&& (above.isAir() || BuildHouse.plant(above));
	}

	private static boolean emptyFarmland(ServerLevel level, BlockPos p) {
		return level.getBlockState(p).is(Blocks.FARMLAND) && level.getBlockState(p.above()).isAir();
	}

	/** Squares for the field: open grass or dirt near the owner (around water if there's some close), side by side. */
	private boolean findPlots(ServerLevel level) {
		ServerPlayer o = c.owner();
		BlockPos around = o != null && o.level() == level ? o.blockPosition() : c.blockPosition();
		// water nearby makes a better field
		BlockPos water = null;
		for (BlockPos p : BlockPos.withinManhattan(around, 14, 3, 14)) {
			if (level.getFluidState(p).is(FluidTags.WATER) && level.getFluidState(p).isSource() && level.getBlockState(p.above()).isAir()) { water = p.immutable(); break; }
		}
		BlockPos centre = water != null ? water : null;
		if (centre == null) {
			// the nearest open patch, a few steps from him
			double best = Double.MAX_VALUE;
			for (BlockPos p : BlockPos.withinManhattan(around.below(), 12, 3, 12)) {
				if (p.distManhattan(around.below()) < 3 || !tillable(level, p)) continue;
				int open = 0;
				for (int dx = -1; dx <= 1; dx++) for (int dz = -1; dz <= 1; dz++) if (tillable(level, p.offset(dx, 0, dz)) || emptyFarmland(level, p.offset(dx, 0, dz))) open++;
				double score = (9 - open) * 10 + p.distSqr(around) * 0.1;
				if (score < best) { best = score; centre = p.immutable(); }
			}
		}
		if (centre == null) return false;
		final BlockPos mid = centre;
		List<BlockPos> cand = new ArrayList<>();
		for (int dx = -3; dx <= 3; dx++) for (int dz = -3; dz <= 3; dz++) for (int dy = -1; dy <= 1; dy++) {
			BlockPos p = mid.offset(dx, dy, dz);
			if (p.equals(mid) && water != null) continue;
			if (tillable(level, p) || emptyFarmland(level, p)) cand.add(p);
		}
		cand.sort(Comparator.comparingDouble(p -> p.distSqr(mid)));
		for (BlockPos p : cand) { if (plots.size() >= want) break; plots.add(p); }
		return !plots.isEmpty();
	}

	private @Nullable BlockPos nearestGrass(ServerLevel level) {
		BlockPos me = c.blockPosition();
		BlockPos best = null;
		double bestD = Double.MAX_VALUE;
		for (BlockPos p : BlockPos.withinManhattan(me, 12, 3, 12)) {
			BlockState s = level.getBlockState(p);
			if (!(s.is(Blocks.SHORT_GRASS) || s.is(Blocks.TALL_GRASS) || s.is(Blocks.FERN))) continue;
			double d = p.distSqr(me);
			if (d < bestD) { bestD = d; best = p.immutable(); }
		}
		return best;
	}

	// ---------------------------------------------------------------- harvesting

	private List<BlockPos> ripe(ServerLevel level) {
		ServerPlayer o = c.owner();
		BlockPos around = o != null && o.level() == level ? o.blockPosition() : c.blockPosition();
		List<BlockPos> out = new ArrayList<>();
		for (BlockPos p : BlockPos.withinManhattan(around, 16, 4, 16)) {
			BlockState s = level.getBlockState(p);
			if (s.getBlock() instanceof CropBlock crop && crop.isMaxAge(s)) out.add(p.immutable());
		}
		return out;
	}

	private Status harvestStep(ServerLevel level) {
		// replant what she just picked (on the farmland left behind)
		if (at != null) {
			BlockPos soil = at.below();
			// (dry farmland with nothing on it turns back to dirt: till it again first)
			if (!level.getBlockState(soil).is(Blocks.FARMLAND) && tillable(level, soil) && c.count(s -> s.is(ItemTags.HOES)) > 0 && c.count(SEEDS) > 0) {
				if (!near(level, soil)) return Status.RUNNING;
				c.holdMatching(s -> s.is(ItemTags.HOES));
				c.swingArm();
				level.setBlock(soil, Blocks.FARMLAND.defaultBlockState(), 11);
				level.playSound(null, soil, SoundEvents.HOE_TILL, SoundSource.BLOCKS, 1.0F, 1.0F);
			}
			if (emptyFarmland(level, soil) && c.count(SEEDS) > 0) {
				if (!near(level, soil)) return Status.RUNNING;
				CropBlock crop = seedFor(level, soil);
				List<ItemStack> seed = c.take(s -> SEEDS.test(s) && ((BlockItem) s.getItem()).getBlock() == crop, 1);
				if (seed.isEmpty()) seed = c.take(SEEDS, 1);
				if (!seed.isEmpty()) {
					CropBlock cb = (CropBlock) ((BlockItem) seed.get(0).getItem()).getBlock();
					c.swingArm();
					level.setBlock(soil.above(), cb.getStateForAge(0), 3);
					level.playSound(null, soil, SoundEvents.CROP_PLANTED, SoundSource.BLOCKS, 1.0F, 1.0F);
				}
			}
			at = null;
			walking = 0;
			stand = null;
			return Status.RUNNING;
		}
		plots.removeIf(p -> !(level.getBlockState(p).getBlock() instanceof CropBlock cb && cb.isMaxAge(level.getBlockState(p))));
		if (plots.isEmpty()) {
			plots.addAll(ripe(level));
			if (plots.isEmpty()) {
				// a last pass: sow any picked square still bare (seeds from one plant can land after she moved on)
				harvested.removeIf(p -> !emptyFarmland(level, p) && !(tillable(level, p) && c.count(s -> s.is(ItemTags.HOES)) > 0));
				if (!harvested.isEmpty() && c.count(SEEDS) > 0) {
					at = harvested.remove(0).above();
					return Status.RUNNING;
				}
				return finish("");
			}
		}
		BlockPos next = plots.stream().min(Comparator.comparingDouble(p -> p.getCenter().distanceToSqr(c.position()))).get();
		plots.remove(next);
		breaker = new Breaker(c, next);
		return Status.RUNNING;
	}

	private @Nullable CropBlock seedFor(ServerLevel level, BlockPos soil) { return null; }

	@Override
	public boolean wants(ItemEntity item) {
		return super.wants(item);
	}

	@Override
	public void cancel(ServerLevel level) {
		if (sub != null) sub.cancel(level);
		if (breaker != null) breaker.clear(level);
	}
}
