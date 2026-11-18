package opennpc.jobs;

import java.util.Optional;
import java.util.function.Predicate;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.Identifier;
import net.minecraft.tags.ItemTags;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import org.jspecify.annotations.Nullable;

/** Turns the words the AI uses ("stone pickaxe", "oak logs", "coal") into Minecraft items. */
public final class ItemNames {
	private ItemNames() {}

	static String slug(String s) {
		return s.trim().toLowerCase().replaceFirst("^minecraft:", "").replaceAll("[\\s-]+", "_").replaceAll("[^a-z0-9_]", "");
	}

	/** One exact item for a name ("stone pickaxe" -> stone_pickaxe, "sticks" -> stick, "crafting table"), or null. */
	public static @Nullable Item item(String name) {
		String s = slug(name);
		if (s.isEmpty()) return null;
		for (String t : new String[] {s, s.replaceAll("es$", ""), s.replaceAll("s$", ""), s.replace("wood_", "wooden_"), s.replace("gold_", "golden_")}) {
			Optional<Item> it = Identifier.tryParse("minecraft:" + t) == null ? Optional.empty() : BuiltInRegistries.ITEM.getOptional(Identifier.parse("minecraft:" + t));
			if (it.isPresent() && it.get() != Items.AIR) return it.get();
		}
		return null;
	}

	/** Which of her items a name means ("logs" = any logs, "coal", "iron" = raw iron and iron things), or null. */
	public static @Nullable Predicate<ItemStack> matcher(String name) {
		String s = slug(name);
		if (s.isEmpty()) return null;
		if (s.matches("(\\w+_)?(logs?|wood)")) {
			String w = s.replaceAll("_?(logs?|wood)$", "");
			return st -> st.is(ItemTags.LOGS) && (w.isEmpty() || path(st).contains(w));
		}
		if (s.matches("planks?")) return st -> st.is(ItemTags.PLANKS);
		if (s.matches("pickaxes?")) return st -> st.is(ItemTags.PICKAXES);
		if (s.matches("swords?")) return st -> st.is(ItemTags.SWORDS);
		if (s.matches("axes?")) return st -> st.is(ItemTags.AXES);
		if (s.matches("tools?")) return CraftJob::isTool;
		if (s.matches("(cobble)?stones?|cobblestones?")) return st -> st.is(ItemTags.STONE_TOOL_MATERIALS) || st.is(Items.STONE);
		Item exact = item(s);
		if (exact != null) return st -> st.is(exact);
		String root = s.replaceAll("e?s$", "");
		return st -> path(st).contains(root);
	}

	static String path(ItemStack st) {
		return BuiltInRegistries.ITEM.getKey(st.getItem()).getPath();
	}
}
