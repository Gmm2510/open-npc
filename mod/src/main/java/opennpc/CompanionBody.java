package opennpc;

import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;
import java.util.function.Function;
import java.util.function.Supplier;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.monster.Enemy;
import net.minecraft.world.level.Level;
import java.util.function.Predicate;
import net.minecraft.tags.ItemTags;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import opennpc.brain.Brain;
import opennpc.entity.CompanionEntity;
import opennpc.jobs.BuildHouse;
import opennpc.jobs.CraftJob;
import opennpc.jobs.Farm;
import opennpc.jobs.Fight;
import opennpc.jobs.GatherWood;
import opennpc.jobs.Give;
import opennpc.jobs.ItemNames;
import opennpc.jobs.Mine;
import opennpc.jobs.PickUp;
import opennpc.jobs.Work;
import org.jspecify.annotations.Nullable;

/**
 * What the AI sees of the companion (her situation, what she can do) and what it can make her do.
 * Main thread only.
 */
public final class CompanionBody implements Brain.Body {
	/** What she can do now, in the order the AI sees them. More come with later steps (jobs, building, farming). */
	public static final Map<String, String> ACTIONS;
	static {
		Map<String, String> a = new LinkedHashMap<>();
		a.put("follow", "stay close to the owner (the default)");
		a.put("come", "walk over to the owner right now");
		a.put("stay", "wait right here until told to follow or come");
		a.put("emote", "a little wave and a hop");
		a.put("stop_task", "stop what you are doing and follow");
		a.put("attack", "fight the nearest hostile mob");
		a.put("guard", "guard the owner for two minutes");
		a.put("pick_up", "pick up items lying nearby");
		a.put("gather_wood", "chop trees and bring the owner the logs {n, wood}");
		a.put("mine_stone", "mine stone that shows, on hillsides or in caves {n}");
		a.put("mine_coal", "mine coal and bring it {n}");
		a.put("mine_iron", "mine iron ore and bring it {n}");
		a.put("mine_gold", "mine gold ore and bring it {n}");
		a.put("mine_diamonds", "mine diamonds and bring them {n}");
		a.put("make_tools", "craft a tool for yourself {item}, or for the owner {item, who: me}");
		a.put("craft_item", "craft something {item, n}, for the owner {who: me}");
		a.put("give_loot", "hand the owner items {item, n}; no item: everything you carry but your tools");
		a.put("build_house", "build a small wooden house near the owner (gets the wood herself)");
		a.put("farm", "make a small field and plant it {n: squares, up to 25}");
		a.put("harvest", "pick the ripe crops around and plant them again");
		ACTIONS = java.util.Collections.unmodifiableMap(a);
	}

	private final Supplier<@Nullable CompanionEntity> companion;
	private final Supplier<@Nullable ServerPlayer> owner;
	private final Supplier<String> name;
	private final Supplier<String> ownerName;
	private final Consumer<String> chat;
	private final Function<ServerPlayer, @Nullable CompanionEntity> summon;
	public Runnable onCommand = () -> {};
	public Consumer<CompanionEntity> afterCommand = c -> {};

	public CompanionBody(Supplier<@Nullable CompanionEntity> companion, Supplier<@Nullable ServerPlayer> owner, Supplier<String> name,
		Supplier<String> ownerName, Consumer<String> chat, Function<ServerPlayer, @Nullable CompanionEntity> summon) {
		this.companion = companion;
		this.owner = owner;
		this.name = name;
		this.ownerName = ownerName;
		this.chat = chat;
		this.summon = summon;
	}

	@Override
	public String name() { return name.get(); }

	@Override
	public String owner() { return ownerName.get(); }

	@Override
	public Map<String, String> actions() { return ACTIONS; }

	@Override
	public Map<String, String> situation() {
		Map<String, String> s = new LinkedHashMap<>();
		CompanionEntity c = companion.get();
		if (c == null) {
			s.put("where you are", "not in the world right now");
			return s;
		}
		Level level = c.level();
		s.put("your health", Math.round(c.getHealth()) + "/" + Math.round(c.getMaxHealth()));
		s.put("time", level.isBrightOutside() ? "day" : "night");
		if (level.isThundering()) s.put("weather", "thunderstorm");
		else if (level.isRaining()) s.put("weather", "rain");
		ServerPlayer o = owner.get();
		String on = owner();
		if (o == null) s.put(on.isEmpty() ? "the player" : on, "not online");
		else if (o.level() != level) s.put("distance to " + (on.isEmpty() ? "the player" : on), "in another dimension");
		else s.put("distance to " + (on.isEmpty() ? "the player" : on), Math.round(c.distanceTo(o)) + " blocks");
		Map<String, Integer> hostile = new LinkedHashMap<>();
		for (LivingEntity e : level.getEntitiesOfClass(LivingEntity.class, c.getBoundingBox().inflate(16), e -> e instanceof Enemy && e.isAlive())) {
			hostile.merge(e.getType().getDescription().getString().toLowerCase(), 1, Integer::sum);
		}
		if (!hostile.isEmpty()) {
			List<String> h = new ArrayList<>();
			hostile.forEach((k, v) -> h.add(v == 1 ? "a " + k : v + " " + k + "s"));
			s.put("hostile mobs nearby", String.join(", ", h));
		}
		s.put("doing now", c.doing());
		List<String> tools = new ArrayList<>();
		List<String> carry = new ArrayList<>();
		Map<net.minecraft.world.item.Item, Integer> bag = c.bag();
		for (Map.Entry<net.minecraft.world.item.Item, Integer> e : bag.entrySet()) {
			String name = opennpc.jobs.Crafter.name(e.getKey());
			if (opennpc.jobs.CraftJob.isTool(new net.minecraft.world.item.ItemStack(e.getKey()))) tools.add(name);
			else carry.add(e.getValue() + " " + name);
		}
		s.put("your tools", tools.isEmpty() ? "none" : String.join(", ", tools));
		s.put("carrying", carry.isEmpty() ? "nothing" : String.join(", ", carry.subList(0, Math.min(8, carry.size()))));
		s.put("your height (y)", String.valueOf(c.getBlockY()));
		if (level.dimension() == Level.NETHER) s.put("where you are", "the Nether");
		else if (level.dimension() == Level.END) s.put("where you are", "the End");
		return s;
	}

	@Override
	public Brain.Result command(String action, JsonObject args, boolean byPlayer) {
		onCommand.run();
		CompanionEntity c = companion.get();
		ServerPlayer o = owner.get();
		if (c == null) {
			if (o == null || !(action.equals("come") || action.equals("follow") || action.equals("stop_task"))) return Brain.Result.no("not_in_the_world");
			c = summon.apply(o);
			if (c == null) return Brain.Result.no("no_room_near_you");
		}
		Work job = null;
		switch (action) {
			case "follow", "stop_task" -> c.setMode(CompanionEntity.Mode.FOLLOW);
			case "come" -> c.setMode(CompanionEntity.Mode.COME);
			case "stay" -> c.setMode(CompanionEntity.Mode.STAY);
			case "emote" -> c.emote();
			case "attack" -> job = new Fight(c, byPlayer, null, false);
			case "guard" -> job = new Fight(c, byPlayer, null, true);
			case "pick_up" -> job = new PickUp(c, byPlayer);
			case "gather_wood" -> job = new GatherWood(c, byPlayer, num(args, 8), wood(str(args, "wood") + " " + str(args, "item")), true);
			case "mine_stone" -> job = new Mine(c, byPlayer, Mine.Kind.STONE, num(args, 8), false);
			case "mine_coal" -> job = new Mine(c, byPlayer, Mine.Kind.COAL, num(args, 4), true);
			case "mine_iron" -> job = new Mine(c, byPlayer, Mine.Kind.IRON, num(args, 4), true);
			case "mine_gold" -> job = new Mine(c, byPlayer, Mine.Kind.GOLD, num(args, 4), true);
			case "mine_diamonds" -> job = new Mine(c, byPlayer, Mine.Kind.DIAMONDS, num(args, 2), true);
			case "make_tools", "craft_item" -> {
				String name = str(args, "item");
				Item it = name.isEmpty() && action.equals("make_tools") ? (c.count(st -> st.is(ItemTags.STONE_TOOL_MATERIALS)) >= 3 ? Items.STONE_PICKAXE : Items.WOODEN_PICKAXE) : ItemNames.item(name);
				if (it == null) return Brain.Result.no(name.isEmpty() ? "no_item_named" : "doesn't know " + name);
				job = new CraftJob(c, byPlayer, it, action.equals("make_tools") ? 1 : num(args, 1), "me".equals(str(args, "who")));
			}
			case "give_loot" -> {
				String name = str(args, "item");
				Predicate<ItemStack> which = name.isEmpty() ? st -> !CraftJob.isTool(st) : ItemNames.matcher(name);
				if (which == null) return Brain.Result.no("doesn't know " + name);
				if (c.count(which) == 0) return Brain.Result.no(name.isEmpty() ? "carrying_nothing" : "has no " + name);
				job = new Give(c, byPlayer, which, args.has("n") ? num(args, 0) : 0, name.isEmpty() ? "what she carries" : name);
			}
			case "build_house" -> job = new BuildHouse(c, byPlayer);
			case "farm" -> job = new Farm(c, byPlayer, num(args, 9), false);
			case "harvest" -> job = new Farm(c, byPlayer, 25, true);
			default -> { return Brain.Result.no("unknown"); }
		}
		if (job != null && !c.startJob(job)) return Brain.Result.no("busy with " + c.doing());
		afterCommand.accept(c);
		return Brain.Result.started();
	}

	@Override
	public void say(String text) {
		chat.accept(text);
	}

	static int num(JsonObject args, int dflt) {
		try { return args.has("n") ? Math.max(1, Math.min(640, (int) Math.round(args.get("n").getAsDouble()))) : dflt; } catch (Exception e) { return dflt; }
	}

	static String str(JsonObject args, String k) {
		try { return args.has(k) ? args.get(k).getAsString().trim().toLowerCase() : ""; } catch (Exception e) { return ""; }
	}

	static final List<String> WOODS = List.of("dark_oak", "pale_oak", "oak", "spruce", "birch", "jungle", "acacia", "mangrove", "cherry", "crimson", "warped");

	/** "birch logs" -> "birch"; anything else -> "" (any wood). */
	static String wood(String s) {
		String t = s.toLowerCase().replace(' ', '_');
		for (String w : WOODS) if (t.contains(w)) return w;
		return "";
	}

	/** True when the level the companion is in is this one (for tests and checks). */
	public boolean in(ServerLevel level) {
		CompanionEntity c = companion.get();
		return c != null && c.level() == level;
	}
}
