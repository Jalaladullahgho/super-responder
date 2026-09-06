import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";

interface ChatPayload {
  mac_address?: string;
  username?: string;
  message?: string;
  conversation_id?: number | string | null;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const AUTO_REPLY = "تم استلام رسالتك بنجاح. سيتم الرد عليك من الدعم.";

console.info("super-responder started");

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function normalizeConversationId(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;

  const id = typeof value === "number" ? value : Number(value);

  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return id;
}

export default {
  fetch: withSupabase(
    { auth: ["publishable", "secret"] },
    async (req, ctx) => {
      if (req.method === "OPTIONS") {
        return new Response("ok", {
          status: 200,
          headers: corsHeaders,
        });
      }

      if (req.method === "GET") {
        return jsonResponse({
          success: true,
          service: "super-responder",
          status: "online",
        });
      }

      if (req.method !== "POST") {
        return jsonResponse(
          {
            success: false,
            error: "Method not allowed",
          },
          405,
        );
      }

      try {
        const body: ChatPayload = await req.json();

        const macAddress = body.mac_address?.trim();
        const username = body.username?.trim() || null;
        const message = body.message?.trim();
        const requestedConversationId = normalizeConversationId(
          body.conversation_id,
        );

        if (!macAddress) {
          return jsonResponse(
            {
              success: false,
              error: "mac_address is required",
            },
            400,
          );
        }

        if (!message) {
          return jsonResponse(
            {
              success: false,
              error: "message is required",
            },
            400,
          );
        }

        const supabase = ctx.supabase;

        // ------------------------------------------------------------
        // 1) Find or create the client by MAC address.
        // ------------------------------------------------------------
        const { data: existingClient, error: clientSelectError } =
          await supabase
            .from("clients")
            .select("id, mac_address, username")
            .eq("mac_address", macAddress)
            .maybeSingle();

        if (clientSelectError) {
          throw new Error(
            `Client lookup failed: ${clientSelectError.message}`,
          );
        }

        let clientId: number;

        if (!existingClient) {
          const { data: newClient, error: clientInsertError } =
            await supabase
              .from("clients")
              .insert({
                mac_address: macAddress,
                username,
                last_seen_at: new Date().toISOString(),
              })
              .select("id")
              .single();

          if (clientInsertError) {
            throw new Error(
              `Client creation failed: ${clientInsertError.message}`,
            );
          }

          clientId = newClient.id;
        } else {
          clientId = existingClient.id;

          const { error: clientUpdateError } = await supabase
            .from("clients")
            .update({
              ...(username !== null ? { username } : {}),
              last_seen_at: new Date().toISOString(),
            })
            .eq("id", clientId);

          if (clientUpdateError) {
            throw new Error(
              `Client update failed: ${clientUpdateError.message}`,
            );
          }
        }

        // ------------------------------------------------------------
        // 2) Reuse the supplied conversation when it belongs to this
        //    client. Otherwise reuse the latest conversation for the
        //    same client. Create one only when none exists.
        // ------------------------------------------------------------
        let conversationId: number | null = null;
        let conversationWasCreated = false;

        if (requestedConversationId !== null) {
          const { data: requestedConversation, error: requestedConversationError } =
            await supabase
              .from("conversations")
              .select("id, client_id, status")
              .eq("id", requestedConversationId)
              .eq("client_id", clientId)
              .maybeSingle();

          if (requestedConversationError) {
            throw new Error(
              `Conversation validation failed: ${requestedConversationError.message}`,
            );
          }

          if (requestedConversation) {
            conversationId = requestedConversation.id;
          }
        }

        if (conversationId === null) {
          const { data: existingConversation, error: conversationSelectError } =
            await supabase
              .from("conversations")
              .select("id, client_id, status")
              .eq("client_id", clientId)
              .order("updated_at", { ascending: false })
              .order("created_at", { ascending: false })
              .limit(1)
              .maybeSingle();

          if (conversationSelectError) {
            throw new Error(
              `Conversation lookup failed: ${conversationSelectError.message}`,
            );
          }

          if (existingConversation) {
            conversationId = existingConversation.id;
          }
        }

        if (conversationId === null) {
          const { data: newConversation, error: conversationInsertError } =
            await supabase
              .from("conversations")
              .insert({
                client_id: clientId,
                status: "open",
              })
              .select("id")
              .single();

          if (conversationInsertError) {
            throw new Error(
              `Conversation creation failed: ${conversationInsertError.message}`,
            );
          }

          conversationId = newConversation.id;
          conversationWasCreated = true;
        }

        // ------------------------------------------------------------
        // 3) IMPORTANT: Determine whether this is the first CLIENT
        //    message before inserting the current message.
        //    We count client messages only, so an old admin greeting
        //    cannot prevent the client's first message from receiving
        //    the one-time automatic acknowledgement.
        // ------------------------------------------------------------
        const { count: previousClientMessages, error: messageCountError } =
          await supabase
            .from("messages")
            .select("id", { count: "exact", head: true })
            .eq("conversation_id", conversationId)
            .eq("sender", "client");

        if (messageCountError) {
          throw new Error(
            `Message history check failed: ${messageCountError.message}`,
          );
        }

        const isFirstClientMessage = (previousClientMessages ?? 0) === 0;

        // ------------------------------------------------------------
        // 4) Save the customer's message.
        // ------------------------------------------------------------
        const { data: savedMessage, error: messageInsertError } =
          await supabase
            .from("messages")
            .insert({
              conversation_id: conversationId,
              sender: "client",
              message,
              is_read: false,
            })
            .select("*")
            .single();

        if (messageInsertError) {
          throw new Error(
            `Message creation failed: ${messageInsertError.message}`,
          );
        }

        const now = new Date().toISOString();

        // Keep the conversation's last activity current.
        const { error: conversationUpdateError } = await supabase
          .from("conversations")
          .update({
            updated_at: now,
          })
          .eq("id", conversationId);

        if (conversationUpdateError) {
          throw new Error(
            `Conversation update failed: ${conversationUpdateError.message}`,
          );
        }

        // ------------------------------------------------------------
        // 5) Send the automatic acknowledgement ONLY on the first
        //    client message. Later messages are saved with no automatic
        //    reply. Admin messages continue to work independently.
        // ------------------------------------------------------------
        let savedResponse = null;

        if (isFirstClientMessage) {
          const { data: autoResponse, error: responseInsertError } =
            await supabase
              .from("messages")
              .insert({
                conversation_id: conversationId,
                sender: "admin",
                message: AUTO_REPLY,
                is_read: false,
              })
              .select("*")
              .single();

          if (responseInsertError) {
            throw new Error(
              `Response creation failed: ${responseInsertError.message}`,
            );
          }

          savedResponse = autoResponse;

          await supabase
            .from("conversations")
            .update({
              updated_at: new Date().toISOString(),
            })
            .eq("id", conversationId);
        }

        return jsonResponse({
          success: true,
          client_id: clientId,
          conversation_id: conversationId,
          conversation_created: conversationWasCreated,
          first_client_message: isFirstClientMessage,
          user_message: savedMessage,
          response: savedResponse,
        });
      } catch (error) {
        console.error("super-responder error:", error);

        return jsonResponse(
          {
            success: false,
            error:
              error instanceof Error
                ? error.message
                : "Internal Server Error",
          },
          500,
        );
      }
    },
  ),
};
