// Simplified MSG91 SMS Integration (No Signature Verification - For Testing Only)
// Use this version to test if the payload structure is correct
// WARNING: This version does NOT verify the webhook signature!

const MSG91_AUTH_KEY = Deno.env.get("MSG91_AUTH_KEY")!;
const MSG91_TEMPLATE_ID = Deno.env.get("MSG91_TEMPLATE_ID")!;

Deno.serve(async (req) => {
  try {
    console.log("📥 Received SMS OTP webhook request");
    
    // Parse the incoming payload
    const payload = await req.text();
    console.log("📄 Raw payload:", payload);
    
    let webhookData;
    try {
      webhookData = JSON.parse(payload);
      console.log("📦 Parsed webhook data:", JSON.stringify(webhookData, null, 2));
    } catch (err) {
      console.error("❌ Failed to parse JSON:", err);
      return new Response(
        JSON.stringify({ 
          error: { 
            http_code: 400, 
            message: "Invalid JSON payload" 
          } 
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Extract phone and OTP from Supabase Auth webhook payload
    // During an updateUser phone flow, the new unverified phone is stored in new_phone instead of phone.
    const phone = webhookData.user?.phone || webhookData.user?.new_phone || webhookData.user?.phone_change;
    const otp = webhookData.sms?.otp;
    
    console.log("📱 Extracted phone:", phone);
    console.log("🔢 Extracted OTP:", otp);
    
    if (!phone || !otp) {
      console.error("❌ Missing phone or OTP");
      console.log("Available data:", JSON.stringify(webhookData, null, 2));
      return new Response(
        JSON.stringify({ 
          error: { 
            http_code: 400, 
            message: `Missing required fields. Phone: ${phone}, OTP: ${otp}` 
          } 
        }), 
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Clean phone number (remove '+' for MSG91)
    const cleanPhone = phone.replace(/^\+/, "");
    console.log("📞 Sending to clean phone:", cleanPhone);

    // Send OTP via MSG91
    console.log("📤 Calling MSG91 API...");
    const safeTemplateId = MSG91_TEMPLATE_ID.replace(/["']/g, "").trim();
    const safeAuthKey = MSG91_AUTH_KEY.replace(/["']/g, "").trim();

    const msg91Response = await fetch("https://control.msg91.com/api/v5/flow/", {
      method: "POST",
      headers: {
        "authkey": safeAuthKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        template_id: safeTemplateId,
        short_url: "0",
        recipients: [
          {
            mobiles: String(cleanPhone),
            var: "PolicyWise",
            var1: String(otp)
          }
        ]
      })
    });

    const msg91Data = await msg91Response.json();
    console.log("📨 MSG91 Response:", JSON.stringify(msg91Data, null, 2));

    if (msg91Data.type === "error") {
      console.error("❌ MSG91 Error:", msg91Data.message);
      throw new Error(`MSG91: ${msg91Data.message}`);
    }

    console.log("✅ SMS sent successfully!");
    
    // Return success (empty object as per Supabase Auth requirements)
    return new Response(
      JSON.stringify({}), 
      { 
        status: 200,
        headers: { "Content-Type": "application/json" }
      }
    );
    
  } catch (error) {
    console.error("❌ Error:", error);
    return new Response(
      JSON.stringify({ 
        error: { 
          http_code: 400, 
          message: error instanceof Error ? error.message : "Unknown error" 
        } 
      }), 
      { 
        status: 400, 
        headers: { "Content-Type": "application/json" } 
      } 
    );
  }
});
