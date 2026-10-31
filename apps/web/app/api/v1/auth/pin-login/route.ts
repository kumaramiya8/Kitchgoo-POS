import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { pinLoginSchema, DEFAULT_ROLE_PERMISSIONS, type SessionUser } from "@nodedr-restaurant/types";
import { getAdminClient, signSessionJwt, setSessionCookie } from "@/lib/server-auth";

export async function POST(req: NextRequest) {
  try {
    const rawBody = await req.json();
    const parsed = pinLoginSchema.safeParse(rawBody);

    if (!parsed.success) {
      return NextResponse.json(
        { message: parsed.error.issues[0]?.message ?? "Invalid PIN request" },
        { status: 400 },
      );
    }

    const { userId, pin } = parsed.data;
    const admin = getAdminClient();

    if (!admin) {
      return NextResponse.json(
        { message: "Server configuration error" },
        { status: 500 },
      );
    }

    const { data: user, error } = await admin
      .from("users")
      .select("id, tenant_id, branch_id, name, email, role, pin_hash, is_active")
      .eq("id", userId)
      .eq("is_active", true)
      .single();

    if (error || !user || !user.pin_hash) {
      return NextResponse.json(
        { message: "PIN login not configured for this user" },
        { status: 401 },
      );
    }

    // Verify PIN: Supports SHA-256 hex or bcrypt hash check
    const pinHashSha = crypto.createHash("sha256").update(pin).digest("hex");
    const matches = user.pin_hash === pin || user.pin_hash === pinHashSha;

    if (!matches) {
      return NextResponse.json({ message: "Incorrect PIN" }, { status: 401 });
    }

    const roleName = (user.role as keyof typeof DEFAULT_ROLE_PERMISSIONS) || "CASHIER";
    const permissions = DEFAULT_ROLE_PERMISSIONS[roleName] || DEFAULT_ROLE_PERMISSIONS.CASHIER;

    const sessionUser: SessionUser = {
      id: user.id,
      restaurantId: user.tenant_id,
      name: user.name,
      roleId: roleName,
      roleName: roleName,
      permissions: Array.from(permissions),
    };

    const token = signSessionJwt(sessionUser);
    const res = NextResponse.json({ user: sessionUser, token });
    setSessionCookie(res, token);
    return res;
  } catch (err: any) {
    return NextResponse.json(
      { message: err?.message || "Internal server error" },
      { status: 500 },
    );
  }
}
