import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";

interface ChatPayload { mac_address?: string; username?: string; message?: string; conversation_id?: number | string | null; }
const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
const AUTO_REPLY = "تم استلام رسالتك بنجاح. سيتم الرد عليك من الدعم.";
function jsonResponse(payload: unknown, status = 200) { return new Response(JSON.stringify(payload), { status, headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" } }); }
function normalizeConversationId(value: unknown): number | null { if (value === null || value === undefined || value === "") return null; const id = typeof value === "number" ? value : Number(value); return Number.isSafeInteger(id) && id > 0 ? id : null; }
function normalizeMac(value: string | null | undefined) { return (value || "").trim(); }

export default { fetch: withSupabase({ auth: ["publishable", "secret"] }, async (req, ctx) => {
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers: corsHeaders });
  const supabase = ctx.supabase;

  if (req.method === "GET") {
    const url = new URL(req.url);
    if ((url.searchParams.get("action") || "health") !== "bootstrap") return jsonResponse({ success: true, service: "super-responder", status: "online" });
    const macAddress = normalizeMac(url.searchParams.get("mac_address"));
    if (!macAddress) return jsonResponse({ success: false, error: "mac_address is required" }, 400);
    const requestedConversationId = normalizeConversationId(url.searchParams.get("conversation_id"));
    try {
      const { data: client, error: clientError } = await supabase.from("clients").select("id, mac_address, username").eq("mac_address", macAddress).maybeSingle();
      if (clientError) throw new Error(`Client lookup failed: ${clientError.message}`);
      if (!client) return jsonResponse({ success: true, client: null, conversation: null, messages: [] });
      let conversation = null;
      if (requestedConversationId !== null) {
        const { data, error } = await supabase.from("conversations").select("id, client_id, status, created_at, updated_at").eq("id", requestedConversationId).eq("client_id", client.id).maybeSingle();
        if (error) throw new Error(`Conversation validation failed: ${error.message}`);
        conversation = data;
      }
      if (!conversation) {
        const { data, error } = await supabase.from("conversations").select("id, client_id, status, created_at, updated_at").eq("client_id", client.id).order("updated_at", { ascending: false }).order("created_at", { ascending: false }).limit(1).maybeSingle();
        if (error) throw new Error(`Conversation lookup failed: ${error.message}`);
        conversation = data;
      }
      if (!conversation) return jsonResponse({ success: true, client: { id: client.id, username: client.username }, conversation: null, messages: [] });
      const { data: messages, error: messagesError } = await supabase.from("messages").select("id, conversation_id, sender, message, created_at").eq("conversation_id", conversation.id).order("created_at", { ascending: false }).limit(20);
      if (messagesError) throw new Error(`Message history failed: ${messagesError.message}`);
      return jsonResponse({ success: true, client: { id: client.id, username: client.username }, conversation, messages: (messages || []).reverse() });
    } catch (error) { console.error("bootstrap error:", error); return jsonResponse({ success: false, error: error instanceof Error ? error.message : "Internal Server Error" }, 500); }
  }

  if (req.method !== "POST") return jsonResponse({ success: false, error: "Method not allowed" }, 405);
  try {
    const body: ChatPayload = await req.json();
    const macAddress = body.mac_address?.trim(); const username = body.username?.trim() || null; const message = body.message?.trim(); const requestedConversationId = normalizeConversationId(body.conversation_id);
    if (!macAddress) return jsonResponse({ success: false, error: "mac_address is required" }, 400);
    if (!message) return jsonResponse({ success: false, error: "message is required" }, 400);
    if (message.length > 2000) return jsonResponse({ success: false, error: "message is too long" }, 400);
    const { data: existingClient, error: clientSelectError } = await supabase.from("clients").select("id, mac_address, username").eq("mac_address", macAddress).maybeSingle();
    if (clientSelectError) throw new Error(`Client lookup failed: ${clientSelectError.message}`);
    let clientId: number;
    if (!existingClient) {
      const { data: newClient, error } = await supabase.from("clients").insert({ mac_address: macAddress, username, last_seen_at: new Date().toISOString() }).select("id").single();
      if (error) throw new Error(`Client creation failed: ${error.message}`); clientId = newClient.id;
    } else {
      clientId = existingClient.id;
      const { error } = await supabase.from("clients").update({ ...(username !== null ? { username } : {}), last_seen_at: new Date().toISOString() }).eq("id", clientId);
      if (error) throw new Error(`Client update failed: ${error.message}`);
    }
    let conversationId: number | null = null; let conversationWasCreated = false;
    if (requestedConversationId !== null) {
      const { data, error } = await supabase.from("conversations").select("id").eq("id", requestedConversationId).eq("client_id", clientId).maybeSingle();
      if (error) throw new Error(`Conversation validation failed: ${error.message}`); if (data) conversationId = data.id;
    }
    if (conversationId === null) {
      const { data, error } = await supabase.from("conversations").select("id").eq("client_id", clientId).order("updated_at", { ascending: false }).order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (error) throw new Error(`Conversation lookup failed: ${error.message}`); if (data) conversationId = data.id;
    }
    if (conversationId === null) {
      const { data, error } = await supabase.from("conversations").insert({ client_id: clientId, status: "open" }).select("id").single();
      if (error) throw new Error(`Conversation creation failed: ${error.message}`); conversationId = data.id; conversationWasCreated = true;
    }
    const { count: previousClientMessages, error: countError } = await supabase.from("messages").select("id", { count: "exact", head: true }).eq("conversation_id", conversationId).eq("sender", "client");
    if (countError) throw new Error(`Message history check failed: ${countError.message}`);
    const isFirstClientMessage = (previousClientMessages ?? 0) === 0;
    const { data: savedMessage, error: messageError } = await supabase.from("messages").insert({ conversation_id: conversationId, sender: "client", message, is_read: false }).select("*").single();
    if (messageError) throw new Error(`Message creation failed: ${messageError.message}`);
    const { error: updateError } = await supabase.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", conversationId);
    if (updateError) throw new Error(`Conversation update failed: ${updateError.message}`);
    let savedResponse = null;
    if (isFirstClientMessage) {
      const { data, error } = await supabase.from("messages").insert({ conversation_id: conversationId, sender: "admin", message: AUTO_REPLY, is_read: false }).select("*").single();
      if (error) throw new Error(`Response creation failed: ${error.message}`); savedResponse = data;
    }
    return jsonResponse({ success: true, client_id: clientId, conversation_id: conversationId, conversation_created: conversationWasCreated, first_client_message: isFirstClientMessage, user_message: savedMessage, response: savedResponse });
  } catch (error) { console.error("super-responder error:", error); return jsonResponse({ success: false, error: error instanceof Error ? error.message : "Internal Server Error" }, 500); }
})};
