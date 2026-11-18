package opennpc.test;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.Executors;
import java.util.function.Function;

/**
 * A stand-in AI on this PC: OpenAI-style chat completions with tools, and (optionally) the wait door, the way a voice
 * app serves it. reply: the question's user text -> what to do and say. No network, no cost.
 */
final class StandIn implements AutoCloseable {
	record Reply(String action, String text) {}

	final List<JsonObject> seen = new CopyOnWriteArrayList<>();
	private final HttpServer server;
	private final boolean door;
	private final Function<String, Reply> reply;
	private final Object lock = new Object();
	private int words = 0;
	private boolean call = false;

	private StandIn(boolean door, Function<String, Reply> reply) throws IOException {
		this.door = door;
		this.reply = reply;
		this.server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
		this.server.setExecutor(Executors.newCachedThreadPool(r -> { Thread t = new Thread(r, "stand-in AI"); t.setDaemon(true); return t; }));
		this.server.createContext("/v1/", this::handle);
		this.server.start();
		OpenNpcTestMod.cleanup.add(this::close);
	}

	static StandIn start(boolean door, Function<String, Reply> reply) {
		try { return new StandIn(door, reply); } catch (IOException e) { throw new RuntimeException(e); }
	}

	String url() { return "http://127.0.0.1:" + server.getAddress().getPort() + "/v1"; }

	void speak() { synchronized (lock) { words++; lock.notifyAll(); } }

	void setCall(boolean v) { synchronized (lock) { call = v; lock.notifyAll(); } }

	private void handle(HttpExchange x) throws IOException {
		String path = x.getRequestURI().getPath();
		try {
			if (x.getRequestMethod().equals("GET") && path.equals("/v1/wait")) { waitDoor(x); return; }
			if (x.getRequestMethod().equals("GET") && path.equals("/v1/models")) { send(x, 200, "{\"data\":[{\"id\":\"stand-in\"}]}"); return; }
			if (x.getRequestMethod().equals("POST") && path.equals("/v1/chat/completions")) { chat(x); return; }
			send(x, 404, "{}");
		} catch (Exception e) {
			send(x, 500, "{}");
		}
	}

	private void waitDoor(HttpExchange x) throws IOException {
		if (!door) { send(x, 404, "{}"); return; }
		Map<String, String> q = query(x.getRequestURI());
		boolean has = q.containsKey("since");
		int since = has ? Integer.parseInt(q.get("since")) : -1;
		boolean was = "1".equals(q.get("call"));
		long ms = Math.min(25000, q.containsKey("ms") ? Long.parseLong(q.get("ms")) : 25000);
		long until = System.currentTimeMillis() + ms;
		String body;
		synchronized (lock) {
			while (has && words <= since && call == was && System.currentTimeMillis() < until) {
				try { lock.wait(Math.max(1, until - System.currentTimeMillis())); } catch (InterruptedException e) { break; }
			}
			body = "{\"call\":" + call + ",\"words\":" + words + "}";
		}
		send(x, 200, body);
	}

	private void chat(HttpExchange x) throws IOException {
		JsonObject j = JsonParser.parseString(new String(x.getRequestBody().readAllBytes(), StandardCharsets.UTF_8)).getAsJsonObject();
		seen.add(j);
		StringBuilder user = new StringBuilder();
		for (var m : j.getAsJsonArray("messages")) if (m.getAsJsonObject().get("role").getAsString().equals("user")) user.append(m.getAsJsonObject().get("content").getAsString()).append('\n');
		Reply r = reply.apply(user.toString());
		JsonObject msg = new JsonObject();
		msg.addProperty("role", "assistant");
		if (r.text() != null) msg.addProperty("content", r.text());
		if (r.action() != null) {
			JsonObject args = new JsonObject();
			args.addProperty("action", r.action());
			args.add("args", new JsonObject());
			JsonObject fn = new JsonObject();
			fn.addProperty("name", "act");
			fn.addProperty("arguments", args.toString());
			JsonObject call = new JsonObject();
			call.addProperty("id", "c" + seen.size());
			call.addProperty("type", "function");
			call.add("function", fn);
			JsonArray calls = new JsonArray();
			calls.add(call);
			msg.add("tool_calls", calls);
		}
		JsonObject choice = new JsonObject();
		choice.addProperty("index", 0);
		choice.add("message", msg);
		choice.addProperty("finish_reason", r.action() != null ? "tool_calls" : "stop");
		JsonArray choices = new JsonArray();
		choices.add(choice);
		JsonObject res = new JsonObject();
		res.add("choices", choices);
		send(x, 200, res.toString());
	}

	private static Map<String, String> query(URI u) {
		Map<String, String> m = new HashMap<>();
		String q = u.getRawQuery();
		if (q == null) return m;
		for (String p : q.split("&")) { int i = p.indexOf('='); if (i > 0) m.put(p.substring(0, i), p.substring(i + 1)); }
		return m;
	}

	private static void send(HttpExchange x, int code, String body) throws IOException {
		byte[] b = body.getBytes(StandardCharsets.UTF_8);
		x.getResponseHeaders().set("Content-Type", "application/json");
		x.sendResponseHeaders(code, b.length);
		x.getResponseBody().write(b);
		x.close();
	}

	@Override
	public void close() {
		server.stop(0);
	}
}
