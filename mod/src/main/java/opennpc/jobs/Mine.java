package opennpc.jobs;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Deque;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.function.Predicate;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.tags.BlockTags;
import net.minecraft.tags.TagKey;
import net.minecraft.tags.ItemTags;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import opennpc.entity.CompanionEntity;
import org.jspecify.annotations.Nullable;

/**
 * Mines ore (or stone) that shows: on hillsides, in caves, on the surface, at her level or above. She never digs
 * straight down into the ground and never digs through blocks to reach something hidden. She makes the pickaxe it needs
 * first when she can (wood from trees, stone from rocks that show); iron, gold and diamonds need an iron pickaxe she
 * has to be given for now.
 */
public final class Mine extends Work {
	// (by id: the Java names of these two tags moved in Minecraft 26.3)
	private static final TagKey<Block> COAL_ORES = Versions.blockTag("coal_ores");
	private static final TagKey<Block> DIAMOND_ORES = Versions.blockTag("diamond_ores");

	public enum Kind {
		STONE("stone", s -> s.is(BlockTags.BASE_STONE_OVERWORLD), s -> s.is(Items.COBBLESTONE) || s.is(Items.COBBLED_DEEPSLATE) || s.is(Items.STONE) || s.is(Items.DEEPSLATE) || s.is(Items.GRANITE) || s.is(Items.DIORITE) || s.is(Items.ANDESITE) || s.is(Items.TUFF), Blocks.STONE.defaultBlockState()),
		COAL("coal", s -> s.is(COAL_ORES), s -> s.is(Items.COAL), Blocks.COAL_ORE.defaultBlockState()),
		COPPER("copper", s -> s.is(BlockTags.COPPER_ORES), s -> s.is(Items.RAW_COPPER), Blocks.COPPER_ORE.defaultBlockState()),
		IRON("iron", s -> s.is(BlockTags.IRON_ORES), s -> s.is(Items.RAW_IRON), Blocks.IRON_ORE.defaultBlockState()),
		GOLD("gold", s -> s.is(BlockTags.GOLD_ORES), s -> s.is(Items.RAW_GOLD), Blocks.GOLD_ORE.defaultBlockState()),
		DIAMONDS("diamonds", s -> s.is(DIAMOND_ORES), s -> s.is(Items.DIAMOND), Blocks.DIAMOND_ORE.defaultBlockState());

		final String word;
		final Predicate<BlockState> block;
		final Predicate<ItemStack> drop;
		final BlockState sample;

		Kind(String word, Predicate<BlockState> block, Predicate<ItemStack> drop, BlockState sample) {
			this.word = word;
			this.block = block;
			this.drop = drop;
			this.sample = sample;
		}
	}

	private final Kind kind;
	private final int want;
	private final boolean handOver;
	private int start = -1;
	private final Deque<Work> first = new ArrayDeque<>();
	private boolean planned = false;
	private final Set<BlockPos> skip = new HashSet<>();
	private @Nullable Breaker breaker;
	private @Nullable Collect collect;
	private @Nullable Give give;
	private int searchIn = 0, misses = 0;

	public Mine(CompanionEntity c, boolean byPlayer, Kind kind, int want, boolean handOver) {
		super(c, byPlayer);
		this.kind = kind;
		this.want = Math.max(1, Math.min(64, want));
		this.handOver = handOver;
	}

	@Override
	public String label() { return kind == Kind.STONE ? "mining stone" : "mining " + kind.word; }

	private int got() { return Math.max(0, c.count(kind.drop) - start); }

	@Override
	public String progress() {
		if (!first.isEmpty()) return "first: " + first.peek().label();
		return Math.max(0, got()) + "/" + want;
	}

	@Override
	protected Status step(ServerLevel level) {
		if (!planned) {
			planned = true;
			String no = planTool(level);
			if (no != null) return fail(no);
		}
		if (!first.isEmpty()) {
			Work w = first.peek();
			Status s = w.tick(level);
			if (s == Status.RUNNING) return s;
			if (s == Status.FAILED) return fail("couldn't make a pickaxe: " + w.reason);
			first.poll();
			return Status.RUNNING;
		}
		if (start < 0) start = c.count(kind.drop);
		if (give != null) {
			Status s = give.tick(level);
			if (s == Status.RUNNING) return s;
			return s == Status.DONE ? done(give.result) : fail(give.reason);
		}
		if (got() >= want || ticks > 20 * 60 * 4) return finish();
		if (collect != null) {
			if (collect.tick(level)) return Status.RUNNING;
			collect = null;
		}
		if (breaker != null) {
			Breaker.Result r = breaker.tick(level);
			if (r == Breaker.Result.WORKING) return Status.RUNNING;
			if (r == Breaker.Result.CANT) { skip.add(breaker.target); opennpc.OpenNpc.LOG.info("[Open NPC] gave up on the block at {}: {} (she is at {})", breaker.target, breaker.why, c.blockPosition()); }
			else collect = new Collect(c, this::wants, 6);
			breaker = null;
			return Status.RUNNING;
		}
		if (--searchIn > 0) return Status.RUNNING;
		BlockPos next = find(level);
		if (next == null) {
			if (got() > 0) return finish();
			return fail("no " + kind.word + " showing around here; a cave or a hillside would have some");
		}
		breaker = new Breaker(c, next);
		return Status.RUNNING;
	}

	private Status finish() {
		if (got() == 0) return fail("ran out of time");
		if (!handOver || kind == Kind.STONE || c.owner() == null) return done(got() + " " + kind.word);
		give = new Give(c, byPlayer, kind.drop, got(), kind.word);
		return Status.RUNNING;
	}

	/** Gets the pickaxe this needs ready, or says why not. */
	private @Nullable String planTool(ServerLevel level) {
		if (c.hasToolFor(kind.sample)) return null;
		Item tier = new ItemStack(Items.WOODEN_PICKAXE).isCorrectToolForDrops(kind.sample) ? Items.WOODEN_PICKAXE
			: new ItemStack(Items.STONE_PICKAXE).isCorrectToolForDrops(kind.sample) ? Items.STONE_PICKAXE : Items.IRON_PICKAXE;
		if (tier == Items.IRON_PICKAXE) return "needs an iron pickaxe for " + kind.word + " (hand her one: iron needs a furnace, which she can't use yet)";
		boolean hasWoodPick = c.hasToolFor(Blocks.STONE.defaultBlockState());
		if (!hasWoodPick) {
			if (!Crafter.plan(level, c.bag(), Items.WOODEN_PICKAXE, c.countItem(Items.WOODEN_PICKAXE) + 1).ok()) first.add(new GatherWood(c, byPlayer, 3, "", false));
			first.add(new CraftJob(c, byPlayer, Items.WOODEN_PICKAXE, 1, false));
		}
		if (tier == Items.STONE_PICKAXE) {
			int cobble = c.count(s -> s.is(ItemTags.STONE_TOOL_MATERIALS));
			if (cobble < 3) first.add(new Mine(c, byPlayer, Kind.STONE, 3 - cobble, false));
			first.add(new CraftJob(c, byPlayer, Items.STONE_PICKAXE, 1, false));
		}
		return null;
	}

	/** The nearest block of this kind that shows (open air on a side), at her level or above, she hasn't given up on. */
	private @Nullable BlockPos find(ServerLevel level) {
		searchIn = 30;
		BlockPos me = c.blockPosition();
		List<BlockPos> found = new ArrayList<>();
		BlockPos.MutableBlockPos p = new BlockPos.MutableBlockPos();
		int r = kind == Kind.STONE ? 12 : 20;
		for (int dx = -r; dx <= r; dx++) for (int dz = -r; dz <= r; dz++) for (int dy = -2; dy <= 8; dy++) {
			p.set(me.getX() + dx, me.getY() + dy, me.getZ() + dz);
			if (skip.contains(p)) continue;
			BlockState s = level.getBlockState(p);
			if (!kind.block.test(s) || !Breaker.showing(level, p)) continue;
			// (never the block she or the owner stands on)
			if (p.equals(me.below()) || (c.owner() != null && p.equals(c.owner().blockPosition().below()))) continue;
			found.add(p.immutable());
		}
		if (found.isEmpty()) return null;
		found.sort(Comparator.comparingDouble(b -> b.distSqr(me) + (b.getY() < me.getY() ? 6 : 0)));
		return found.get(0);
	}

	@Override
	public void cancel(ServerLevel level) {
		if (breaker != null) breaker.clear(level);
		for (Work w : first) w.cancel(level);
	}
}
