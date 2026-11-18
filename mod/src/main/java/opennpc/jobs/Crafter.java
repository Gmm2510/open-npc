package opennpc.jobs;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import net.minecraft.core.Holder;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.crafting.CraftingInput;
import net.minecraft.world.item.crafting.Ingredient;
import net.minecraft.world.item.crafting.NormalCraftingRecipe;
import net.minecraft.world.item.crafting.RecipeHolder;
import net.minecraft.world.item.crafting.RecipeManager;
import net.minecraft.world.item.crafting.ShapedRecipe;
import net.minecraft.world.item.crafting.ShapelessRecipe;
import org.jspecify.annotations.Nullable;

/**
 * Works out how to craft something from what she carries, using the game's own recipes: logs into planks, planks into
 * sticks, then the tool. Plans on a copy of her bag first, so nothing is used up unless the whole thing works.
 */
public final class Crafter {
	/** One recipe, crafted `times` times, with the item picked for each ingredient. */
	public record Step(NormalCraftingRecipe recipe, List<Item> chosen, int times, Item result, int yield) {
		public boolean needsTable() { return Crafter.needsTable(recipe); }
	}

	public record Plan(List<Step> steps, String missing) {
		public boolean ok() { return missing.isEmpty(); }
		public boolean needsTable() { return steps.stream().anyMatch(Step::needsTable); }
	}

	private static RecipeManager cachedFor;
	private static Map<Item, List<NormalCraftingRecipe>> byResult = new HashMap<>();

	private static synchronized Map<Item, List<NormalCraftingRecipe>> recipes(ServerLevel level) {
		RecipeManager rm = level.getServer().getRecipeManager();
		if (rm != cachedFor) {
			Map<Item, List<NormalCraftingRecipe>> m = new HashMap<>();
			for (RecipeHolder<?> h : rm.getRecipes()) {
				if (h.value() instanceof ShapedRecipe || h.value() instanceof ShapelessRecipe) {
					NormalCraftingRecipe r = (NormalCraftingRecipe) h.value();
					ItemStack out = r.assemble(CraftingInput.EMPTY);
					if (out.isEmpty() || r.placementInfo().ingredients().isEmpty()) continue;
					m.computeIfAbsent(out.getItem(), k -> new ArrayList<>()).add(r);
				}
			}
			// (fewer ingredients first: the simple recipe before the fancy one)
			for (List<NormalCraftingRecipe> l : m.values()) l.sort(Comparator.comparingInt(r -> r.placementInfo().ingredients().size()));
			byResult = m;
			cachedFor = rm;
		}
		return byResult;
	}

	public static boolean needsTable(NormalCraftingRecipe r) {
		if (r instanceof ShapedRecipe s) return s.getWidth() > 2 || s.getHeight() > 2;
		return r.placementInfo().ingredients().size() > 4;
	}

	public static boolean knows(ServerLevel level, Item item) {
		return recipes(level).containsKey(item);
	}

	/** A plan to end up with `need` of the item, given her bag (item -> count). */
	public static Plan plan(ServerLevel level, Map<Item, Integer> bag, Item item, int need) {
		Map<Item, Integer> sim = new HashMap<>(bag);
		List<Step> steps = new ArrayList<>();
		Set<Item> missing = new LinkedHashSet2();
		if (make(level, sim, steps, item, need, 0, new HashSet<>(), missing)) return new Plan(steps, "");
		String m = missing.isEmpty() ? "no recipe for it" : "needs " + String.join(", ", missing.stream().limit(3).map(Crafter::name).toList());
		return new Plan(List.of(), m);
	}

	private static boolean make(ServerLevel level, Map<Item, Integer> sim, List<Step> steps, Item item, int need, int depth, Set<Item> visiting, Set<Item> missing) {
		int have = sim.getOrDefault(item, 0);
		if (have >= need) return true;
		List<NormalCraftingRecipe> rs = recipes(level).get(item);
		if (rs == null || depth > 5 || visiting.contains(item)) { if (depth > 0) missing.add(item); return false; }
		visiting.add(item);
		try {
			for (NormalCraftingRecipe r : rs) {
				int yield = Math.max(1, r.assemble(CraftingInput.EMPTY).getCount());
				int times = (int) Math.ceil((need - have) / (double) yield);
				// three tries: crafting one ingredient can use up another, so look again
				for (int round = 0; round < 3; round++) {
					Map<Item, Integer> s2 = new HashMap<>(sim);
					List<Step> st2 = new ArrayList<>(steps);
					List<Item> chosen = new ArrayList<>();
					Map<Item, Integer> cost = new HashMap<>();
					boolean ok = true;
					for (Ingredient ing : r.placementInfo().ingredients()) {
						Item pick = pick(level, s2, st2, ing, times, cost, depth, visiting, missing);
						if (pick == null) { ok = false; break; }
						chosen.add(pick);
						cost.merge(pick, times, Integer::sum);
					}
					if (!ok) break;
					// check the whole recipe can be paid for at once
					boolean enough = cost.entrySet().stream().allMatch(e -> s2.getOrDefault(e.getKey(), 0) >= e.getValue());
					if (!enough) { sim.putAll(s2); steps.clear(); steps.addAll(st2); continue; }
					for (Map.Entry<Item, Integer> e : cost.entrySet()) s2.merge(e.getKey(), -e.getValue(), Integer::sum);
					s2.merge(item, yield * times, Integer::sum);
					st2.add(new Step(r, chosen, times, item, yield));
					sim.clear();
					sim.putAll(s2);
					steps.clear();
					steps.addAll(st2);
					return true;
				}
			}
			return false;
		} finally {
			visiting.remove(item);
		}
	}

	/** An item for this ingredient that she has `n` of, or can craft `n` of (making it in the plan). */
	private static @Nullable Item pick(ServerLevel level, Map<Item, Integer> sim, List<Step> steps, Ingredient ing, int n, Map<Item, Integer> cost, int depth, Set<Item> visiting, Set<Item> missing) {
		List<Item> options = ing.items().map(Holder::value).sorted(Comparator.comparingInt((Item it) -> -sim.getOrDefault(it, 0))).toList();
		// (enough for this slot on top of what the recipe's other slots already take)
		for (Item it : options) if (sim.getOrDefault(it, 0) >= n + cost.getOrDefault(it, 0)) return it;
		for (Item it : options) {
			Set<Item> sub = new LinkedHashSet2();
			if (make(level, sim, steps, it, n + cost.getOrDefault(it, 0), depth + 1, visiting, sub)) return it;
		}
		if (!options.isEmpty()) missing.add(options.get(0));
		return null;
	}

	/** Her bag after these steps (to plan one thing after another). */
	public static Map<Item, Integer> after(Map<Item, Integer> bag, List<Step> steps) {
		Map<Item, Integer> m = new HashMap<>(bag);
		for (Step st : steps) {
			for (Item in : st.chosen()) m.merge(in, -st.times(), Integer::sum);
			m.merge(st.result(), st.yield() * st.times(), Integer::sum);
		}
		return m;
	}

	public static String name(Item it) {
		return it.getDescriptionId().replaceFirst("^(item|block)\\.minecraft\\.", "").replace('_', ' ');
	}

	/** Her bag as item -> count. */
	public static Map<Item, Integer> bag(List<ItemStack> stacks) {
		Map<Item, Integer> m = new LinkedHashMap<>();
		for (ItemStack s : stacks) if (!s.isEmpty()) m.merge(s.getItem(), s.getCount(), Integer::sum);
		return m;
	}

	/** (insertion order, for the "needs ..." line) */
	private static final class LinkedHashSet2 extends java.util.LinkedHashSet<Item> {}
}
