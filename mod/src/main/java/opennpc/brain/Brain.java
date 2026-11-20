package opennpc.brain;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Executor;
import java.util.function.Consumer;

/**
 * The AI loop, the same way the side program (src/brain.js) does it. It asks any address that speaks OpenAI-style
 * "chat completions with tools" what the companion should do next, and hands the answer to the body. The body does
 * the work itself; the AI only picks the job and its details, the way a player would ask a friend.
 *
 * When it asks:
 *  - the owner typed something in the game chat
 *  - a job ended, failed, or needs something from the owner
 *  - she has had nothing to do for a while (free time)
 *  - an app on this PC with the "wait" door (GET address/wait) says the owner just spoke to her some other way,
 *    for example out loud on a voice call. The app adds the owner's words to the next question itself.
 * One question at a time, at most one every couple of seconds; whatever comes up while one is out is asked next.
 *
 * Threads: everything except the HTTP calls runs on the game's main thread (the {@code main} executor), and
 * {@link #tick()} is called once per server tick.
 */
public final class Brain {
	public interface Body {
		String name();
		String owner();
		/** The situation in plain words, in order: "your health" -> "18/20". */
		Map<String, String> situation();
		/** What she can do now, with a short description of each. */
		Map<String, String> actions();
		Result command(String action, JsonObject args, boolean byPlayer);
		/** Her words in the game chat. */
		void say(String text);
	}

	public record Result(boolean ok, String reason) {
		public static Result started() { return new Result(true, ""); }
		public static Result no(String reason) { return new Result(false, reason); }
	}

	static final Set<String> ASK_ON = Set.of("task_done", "task_failed", "command_needs", "free_time", "player_died", "companion_revived", "mission");
	/** At most one question every 2.5 seconds of game time (50 ticks). */
	public static final int MIN_GAP_TICKS = 50;

	private final Body body;
	private final Executor main;
	private final Consumer<String> log;
	private final HttpClient http;
	private final String url;
	private final String key;
	private volatile String model;
	private final String speak;         // auto, yes, no
	public long timeoutMs = 60000;
	public long waitRetryMs = 60000;

	// main thread only
	private final List<String> happened = new ArrayList<>();
	private final List<String> done = new ArrayList<>();
	private final List<String> typed = new ArrayList<>();
	private final LinkedHashSet<String> reasons = new LinkedHashSet<>();
	private boolean busy = false;
	private long ticks = 0;
	private long lastAskTick = -MIN_GAP_TICKS;
	private int asks = 0;

	private volatile boolean stopped = false;
	private volatile Boolean waitOn = null;   // null: not known yet
	private volatile String appName = "";     // the name the app at the wait door gives her ("" for none)
	private Thread waitThread;
	/** Runs on the game's main thread when the app's name for her changes. */
	public Runnable onAppName = () -> {};

	public Brain(Body body, Executor main, String url, String key, String model, String speakInChat, Consumer<String> log) {
		this.body = body;
		this.main = main;
		this.log = log;
		this.url = url == null ? "" : url.trim().replaceAll("/+$", "");
		this.key = key == null ? "" : key;
		this.model = model == null ? "" : model.trim();
		this.speak = speakInChat == null ? "auto" : speakInChat.trim().toLowerCase();
		this.http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).version(HttpClient.Version.HTTP_1_1).build();
	}

	public String url() { return url; }
	public int asks() { return asks; }
	public boolean busy() { return busy; }
	/** True once the address answered at /wait, false once it said it has no such door, null before it is known. */
	public Boolean waitDoor() { return waitOn; }
	/** The name the app at the wait door gives her (the companion picked there), or "" when it gives none. */
	public String appName() { return appName; }

	/** Her words go in the game chat, unless an app with the wait door speaks for her (or the setting says no). */
	public boolean speakInChat() {
		if (speak.equals("yes") || speak.equals("true")) return true;
		if (speak.equals("no") || speak.equals("false")) return false;
		return !Boolean.TRUE.equals(waitOn);
	}

	// ---------------------------------------------------------------- what comes in (main thread)

	/** The owner typed something in the game chat. */
	public void typed(String text) {
		if (stopped || text == null || text.isBlank()) return;
		typed.add(cut(text.trim(), 300));
		while (typed.size() > 3) typed.remove(0);
		want("typed");
	}

	/** Something happened in the game; some of it is worth a question right away. */
	public void event(String event, Map<String, String> data, boolean high) {
		String line = describe(event, data == null ? Map.of() : data, ownerName());
		if (!line.isEmpty()) {
			happened.add(line);
			while (happened.size() > 8) happened.remove(0);
		}
		if (ASK_ON.contains(event) || high) want(event);
	}

	/** Something worth a question came up: ask on the next tick that is allowed. */
	public void want(String reason) {
		if (stopped) return;
		reasons.add(reason);
	}

	/** Once per server tick. */
	public void tick() {
		ticks++;
		if (stopped || busy || reasons.isEmpty()) return;
		if (ticks < lastAskTick + MIN_GAP_TICKS) return;
		ask();
	}

	// ---------------------------------------------------------------- the question

	private String ownerName() {
		String o = body.owner();
		return o == null || o.isBlank() ? "the player" : o;
	}

	public String system() {
		String name = body.name(), owner = ownerName();
		List<String> l = new ArrayList<>();
		l.add("You control " + name + ", a companion character in a Minecraft survival world, playing alongside " + owner + ".");
		l.add("You only decide what " + name + " does: call the act tool. The body walks, chops, mines, crafts, fights and hands things over by itself and tells you how it went.");
		l.add("When " + owner + " asks for something, do it right away with act. Take the obvious reading of what they want.");
		l.add("When nobody asked for anything, keep going with the current job, or on free time pick one useful thing, or do nothing. Don't start something new in the middle of a job unless " + owner + " asked.");
		l.add(speakInChat()
			? "Anything you write besides the tool call shows up in the game chat as " + name + "'s words: keep it to one short, casual line, or nothing."
			: "Your words are never shown to anyone: when there is something to do, only call the tool; when there is nothing to do, answer with just \"nothing to do\".");
		l.add("Rules: never claim to be human. No slurs, hate, sexual content or dangerous real-world advice. Never ask for personal information.");
		l.add("");
		StringBuilder b = new StringBuilder("Actions: ");
		int i = 0;
		for (Map.Entry<String, String> e : body.actions().entrySet()) {
			if (i++ > 0) b.append(", ");
			b.append(e.getKey()).append(" (").append(e.getValue()).append(")");
		}
		l.add(b.append('.').toString());
		return String.join("\n", l);
	}

	public JsonArray tools() {
		JsonObject action = new JsonObject();
		action.addProperty("type", "string");
		JsonArray en = new JsonArray();
		for (String a : body.actions().keySet()) en.add(a);
		action.add("enum", en);
		action.addProperty("description", "What to do.");
		JsonObject args = new JsonObject();
		args.addProperty("type", "object");
		args.addProperty("description", "Only the details the owner gave. No details: {}.");
		JsonObject props = new JsonObject();
		props.add("action", action);
		props.add("args", args);
		JsonObject params = new JsonObject();
		params.addProperty("type", "object");
		params.add("properties", props);
		JsonArray req = new JsonArray();
		req.add("action");
		params.add("required", req);
		JsonObject fn = new JsonObject();
		fn.addProperty("name", "act");
		fn.addProperty("description", "Make " + body.name() + " do something in the game. One action per call; the body carries it out by itself and reports back.");
		fn.add("parameters", params);
		JsonObject tool = new JsonObject();
		tool.addProperty("type", "function");
		tool.add("function", fn);
		JsonArray tools = new JsonArray();
		tools.add(tool);
		return tools;
	}

	String situationText() {
		StringBuilder b = new StringBuilder();
		for (Map.Entry<String, String> e : body.situation().entrySet()) {
			if (e.getValue() == null || e.getValue().isEmpty()) continue;
			if (b.length() > 0) b.append('\n');
			b.append("- ").append(e.getKey()).append(": ").append(e.getValue());
		}
		return b.toString();
	}

	private void ask() {
		List<String> why = new ArrayList<>(reasons);
		reasons.clear();
		busy = true;
		lastAskTick = ticks;
		String owner = ownerName();
		List<String> saidNow = new ArrayList<>(typed);
		typed.clear();
		List<String> news = new ArrayList<>(happened);
		happened.clear();
		List<String> parts = new ArrayList<>();
		String sit = situationText();
		parts.add("Now:\n" + (sit.isEmpty() ? "- just joined" : sit));
		if (!done.isEmpty()) parts.add("What you were told to do lately:\n- " + String.join("\n- ", done));
		if (!news.isEmpty()) parts.add("What happened:\n- " + String.join("\n- ", news));
		if (!saidNow.isEmpty()) {
			List<String> q = new ArrayList<>();
			for (String t : saidNow) q.add("\"" + t + "\"");
			parts.add(owner + " typed to you: " + String.join(" then ", q));
		} else if (why.contains("free_time")) parts.add("You have had nothing to do for a while. Pick one useful thing, or keep following.");
		else if (why.contains("call")) parts.add(owner + " is with you now.");
		boolean playerAsked = !saidNow.isEmpty() || why.contains("words");

		JsonObject req = new JsonObject();
		if (!model.isEmpty()) req.addProperty("model", model);
		JsonArray messages = new JsonArray();
		messages.add(message("system", system()));
		messages.add(message("user", String.join("\n\n", parts)));
		req.add("messages", messages);
		req.add("tools", tools());
		req.addProperty("tool_choice", "auto");
		req.addProperty("max_tokens", 400);
		req.addProperty("stream", false);

		HttpRequest.Builder hb = HttpRequest.newBuilder(URI.create(url + "/chat/completions"))
			.timeout(Duration.ofMillis(timeoutMs))
			.header("Content-Type", "application/json")
			.POST(HttpRequest.BodyPublishers.ofString(req.toString()));
		if (!key.isEmpty()) hb.header("Authorization", "Bearer " + key);
		HttpRequest httpReq;
		try { httpReq = hb.build(); } catch (Exception e) { busy = false; log.accept("the AI address isn't valid: " + url); return; }
		http.sendAsync(httpReq, HttpResponse.BodyHandlers.ofString()).whenComplete((res, err) -> main.execute(() -> {
			try {
				if (stopped) return;
				if (err != null) { log.accept("couldn't reach the AI: " + rootMessage(err)); return; }
				if (res.statusCode() / 100 != 2) { log.accept("couldn't reach the AI: " + res.statusCode() + " " + cut(res.body(), 200)); return; }
				answer(res.body(), playerAsked);
			} catch (Exception e) {
				log.accept("the AI's answer couldn't be read: " + e.getMessage());
			} finally {
				busy = false;
			}
		}));
	}

	private void answer(String raw, boolean playerAsked) {
		asks++;
		JsonObject res = JsonParser.parseString(raw).getAsJsonObject();
		JsonArray choices = res.has("choices") && res.get("choices").isJsonArray() ? res.getAsJsonArray("choices") : new JsonArray();
		if (choices.isEmpty() || !choices.get(0).getAsJsonObject().has("message")) { log.accept("the AI answered with nothing"); return; }
		JsonObject msg = choices.get(0).getAsJsonObject().getAsJsonObject("message");
		String text = msg.has("content") && msg.get("content").isJsonPrimitive() ? msg.get("content").getAsString().trim() : "";
		if (!text.isEmpty() && speakInChat()) body.say(oneLine(text));
		JsonArray calls = msg.has("tool_calls") && msg.get("tool_calls").isJsonArray() ? msg.getAsJsonArray("tool_calls") : new JsonArray();
		int n = 0;
		for (JsonElement c : calls) {
			if (n >= 2) break;
			JsonObject input;
			try {
				JsonObject fn = c.getAsJsonObject().getAsJsonObject("function");
				JsonElement a = fn.get("arguments");
				input = a == null ? new JsonObject() : a.isJsonObject() ? a.getAsJsonObject() : JsonParser.parseString(a.getAsString()).getAsJsonObject();
			} catch (Exception e) { input = new JsonObject(); }
			String action = input.has("action") && input.get("action").isJsonPrimitive() ? input.get("action").getAsString().trim() : "";
			if (action.isEmpty()) continue;
			n++;
			if (!body.actions().containsKey(action)) { remember(action + ": not something you can do"); continue; }
			JsonObject args = cleanArgs(input.has("args") && input.get("args").isJsonObject() ? input.getAsJsonObject("args") : new JsonObject());
			Result r = body.command(action, args, playerAsked);
			String how = r.ok() ? "started" : "didn't start (" + r.reason().replace('_', ' ') + ")";
			remember(action + (args.size() > 0 ? " " + args : "") + ": " + how);
			log.accept("does " + action + " " + args + ": " + how);
		}
		if (n == 0) log.accept("no move" + (text.isEmpty() ? "" : ": \"" + cut(text, 120) + "\""));
	}

	/** Only short plain details go to the body: numbers and words, no nesting. */
	static JsonObject cleanArgs(JsonObject raw) {
		JsonObject out = new JsonObject();
		int k = 0;
		for (Map.Entry<String, JsonElement> e : raw.entrySet()) {
			if (k >= 8) break;
			String name = e.getKey();
			if (!name.matches("[a-z_]{1,16}")) continue;
			JsonElement v = e.getValue();
			if (!v.isJsonPrimitive()) continue;
			if (v.getAsJsonPrimitive().isNumber()) out.addProperty(name, v.getAsDouble());
			else if (v.getAsJsonPrimitive().isBoolean()) out.addProperty(name, v.getAsBoolean());
			else out.addProperty(name, cut(v.getAsString().trim(), 40));
			k++;
		}
		return out;
	}

	private void remember(String line) {
		done.add(cut(line, 200));
		while (done.size() > 4) done.remove(0);
	}

	private static JsonObject message(String role, String content) {
		JsonObject m = new JsonObject();
		m.addProperty("role", role);
		m.addProperty("content", content);
		return m;
	}

	// ---------------------------------------------------------------- the wait door

	/**
	 * An app that hears the owner some other way (a voice call) answers at GET address/wait when they speak or a call
	 * starts, and adds their words to the next question itself. It can also say her name ("name"): the companion picked
	 * in the app, so the one in the game is the one on the call. An address without the door answers 404; then it looks
	 * again now and then, in case the app is updated or started later.
	 */
	public void start() {
		if (waitThread != null) return;
		waitThread = new Thread(this::waitLoop, "Open NPC wait door");
		waitThread.setDaemon(true);
		waitThread.start();
	}

	private void waitLoop() {
		if (model.isEmpty()) findModel();
		Integer since = null;
		boolean call = false;
		int misses = 0;
		while (!stopped) {
			try {
				String q = since == null ? "" : "?since=" + since + "&call=" + (call ? 1 : 0) + "&ms=25000";
				HttpRequest.Builder hb = HttpRequest.newBuilder(URI.create(url + "/wait" + q)).timeout(Duration.ofSeconds(35)).GET();
				if (!key.isEmpty()) hb.header("Authorization", "Bearer " + key);
				HttpResponse<String> r = http.send(hb.build(), HttpResponse.BodyHandlers.ofString());
				if (r.statusCode() == 404) {
					if (!Boolean.FALSE.equals(waitOn)) log.accept("this AI has no wait door; asking on game events only");
					waitOn = false;
					since = null;
					nap(waitRetryMs);
					continue;
				}
				if (r.statusCode() / 100 != 2) throw new RuntimeException("status " + r.statusCode());
				JsonObject j = JsonParser.parseString(r.body()).getAsJsonObject();
				if (!Boolean.TRUE.equals(waitOn)) log.accept("the wait door is there: asking the moment you speak");
				waitOn = true;
				misses = 0;
				int words = j.has("words") ? j.get("words").getAsInt() : 0;
				boolean nowCall = j.has("call") && j.get("call").getAsBoolean();
				String named = j.has("name") && j.get("name").isJsonPrimitive() ? opennpc.NpcConfig.cleanOrEmpty(j.get("name").getAsString()) : "";
				if (!named.equals(appName)) {
					appName = named;
					log.accept(named.isEmpty() ? "the app gives her no name" : "the app calls her " + named);
					main.execute(onAppName);
				}
				if (since != null && words > since) main.execute(() -> want("words"));
				if (nowCall && !call) main.execute(() -> want("call"));
				since = words;
				call = nowCall;
			} catch (InterruptedException e) {
				return;
			} catch (Exception e) {
				if (stopped) return;
				misses++;
				// (nothing answering yet: her words go in chat until a door shows up)
				if (misses == 1 && waitOn == null) waitOn = false;
				try { nap(Math.min(30000L, 1000L << Math.min(misses, 5))); } catch (InterruptedException ie) { return; }
			}
		}
	}

	private void findModel() {
		try {
			HttpRequest.Builder hb = HttpRequest.newBuilder(URI.create(url + "/models")).timeout(Duration.ofSeconds(5)).GET();
			if (!key.isEmpty()) hb.header("Authorization", "Bearer " + key);
			HttpResponse<String> r = http.send(hb.build(), HttpResponse.BodyHandlers.ofString());
			if (r.statusCode() / 100 != 2) return;
			JsonObject j = JsonParser.parseString(r.body()).getAsJsonObject();
			JsonArray data = j.getAsJsonArray("data");
			if (data != null && !data.isEmpty() && model.isEmpty()) {
				model = data.get(0).getAsJsonObject().get("id").getAsString();
				log.accept("model " + model);
			}
		} catch (Exception ignored) {
		}
	}

	private void nap(long ms) throws InterruptedException {
		if (stopped) throw new InterruptedException();
		Thread.sleep(ms);
	}

	public void stop() {
		stopped = true;
		if (waitThread != null) waitThread.interrupt();
	}

	// ---------------------------------------------------------------- event lines

	/** One plain line for an event from the body, or "". */
	public static String describe(String event, Map<String, String> d, String owner) {
		String task = d.getOrDefault("task", "");
		return switch (event) {
			case "task_started" -> "started " + task;
			case "task_done" -> "finished " + task + (d.containsKey("result") ? ": " + d.get("result") : "");
			case "task_failed" -> "gave up on " + task + (d.containsKey("reason") ? ": " + d.get("reason") : "");
			case "free_time" -> "free time" + (d.containsKey("time") ? " (" + d.get("time") + ")" : "");
			case "player_died" -> owner + " died" + (d.containsKey("cause") ? " (" + d.get("cause") + ")" : "");
			case "player_hurt" -> owner + " got hurt" + (d.containsKey("cause") ? " by " + d.get("cause") : "");
			case "companion_hurt" -> "you got hurt (health " + d.getOrDefault("health", "?") + "/20" + (d.containsKey("cause") ? ", " + d.get("cause") : "") + ")";
			case "companion_downed" -> "you died (" + d.getOrDefault("cause", "") + ")";
			case "companion_revived" -> "you came back after dying";
			case "companion_joined" -> "you joined the world";
			case "came_over" -> "you came over to " + owner;
			case "monster_spotted" -> "spotted a " + d.getOrDefault("monster", "") + " " + d.getOrDefault("distance_m", "") + " blocks away";
			case "mission" -> cut(d.getOrDefault("text", ""), 160);
			default -> "";
		};
	}

	static String cut(String s, int n) { return s == null ? "" : s.length() <= n ? s : s.substring(0, n); }

	static String oneLine(String s) {
		String t = s.replaceAll("\\s+", " ").trim();
		return cut(t, 240);
	}

	private static String rootMessage(Throwable t) {
		while (t.getCause() != null) t = t.getCause();
		String m = t.getMessage();
		return m == null || m.isEmpty() ? t.getClass().getSimpleName() : m;
	}

	/** For tests: a copy of the situation lines in the order they are sent. */
	public Map<String, String> situationForTest() { return new LinkedHashMap<>(body.situation()); }
}
