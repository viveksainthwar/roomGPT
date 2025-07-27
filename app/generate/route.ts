import { Ratelimit } from "@upstash/ratelimit";
import redis from "../../utils/redis";
import { NextResponse } from "next/server";
import { headers } from "next/headers";

// Rate limit: 5 requests / 24 hours
const ratelimit = redis
  ? new Ratelimit({
      redis,
      limiter: Ratelimit.fixedWindow(5, "1440 m"),
      analytics: true,
    })
  : undefined;

export async function POST(request: Request) {
  try {
    // ✅ 1. Rate limiting
    if (ratelimit) {
      const headersList = headers();
      const ipIdentifier = headersList.get("x-real-ip") ?? "unknown-ip";
      const result = await ratelimit.limit(ipIdentifier);

      if (!result.success) {
        return NextResponse.json(
          { error: "Too many uploads in 1 day. Please try again in 24 hours." },
          {
            status: 429,
            headers: {
              "X-RateLimit-Limit": result.limit.toString(),
              "X-RateLimit-Remaining": result.remaining.toString(),
            },
          }
        );
      }
    }

    // ✅ 2. Parse incoming JSON
    const { imageUrl, theme, room } = await request.json();

    if (!imageUrl || !theme || !room) {
      return NextResponse.json({ error: "Missing required parameters." }, { status: 400 });
    }

    const prompt =
      room === "Gaming Room"
        ? "a room for gaming with gaming computers, gaming consoles, and gaming chairs"
        : `a ${theme.toLowerCase()} ${room.toLowerCase()}`;

    // ✅ 3. Start Replicate prediction
    const startResponse = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Token ${process.env.REPLICATE_API_KEY}`,
      },
      body: JSON.stringify({
        version: "854e8727697a057c525cdb45ab037f64ecca770a1769cc52287c2e56472a247b",
        input: {
          image: imageUrl,
          prompt,
          a_prompt:
            "best quality, extremely detailed, photo from Pinterest, interior, cinematic photo, ultra-detailed, ultra-realistic, award-winning",
          n_prompt:
            "longbody, lowres, bad anatomy, bad hands, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality",
        },
      }),
    });

    if (!startResponse.ok) {
      const errorText = await startResponse.text();
      console.error("🔴 Replicate Start API Error:", errorText);
      return NextResponse.json(
        { error: "Replicate API start failed" },
        { status: 500 }
      );
    }

    const jsonStartResponse = await startResponse.json();
    const endpointUrl = jsonStartResponse?.urls?.get;

    if (!endpointUrl) {
      return NextResponse.json(
        { error: "Replicate response missing endpoint URL" },
        { status: 500 }
      );
    }

    // ✅ 4. Poll until the image is ready
    let restoredImage: string | null = null;
    let attempts = 0;
    const maxAttempts = 30;

    while (!restoredImage && attempts < maxAttempts) {
      const finalResponse = await fetch(endpointUrl, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Token ${process.env.REPLICATE_API_KEY}`,
        },
      });

      const jsonFinalResponse = await finalResponse.json();

      if (jsonFinalResponse.status === "succeeded") {
        restoredImage = jsonFinalResponse.output;
        break;
      } else if (jsonFinalResponse.status === "failed") {
        console.error("🔴 Replicate returned failed status.");
        return NextResponse.json(
          { error: "Image generation failed" },
          { status: 500 }
        );
      }

      await new Promise((res) => setTimeout(res, 1000));
      attempts++;
    }

    // ✅ 5. Timeout condition
    if (!restoredImage) {
      console.error("🕒 Image generation timed out.");
      return NextResponse.json(
        { error: "Image generation timed out." },
        { status: 504 }
      );
    }

    // ✅ 6. Success!
    return NextResponse.json({ image: restoredImage });
  } catch (error: any) {
    console.error("🚨 Unexpected error in /generate:", error);
    return NextResponse.json(
      { error: "Unexpected server error", detail: error?.message || null },
      { status: 500 }
    );
  }
}
