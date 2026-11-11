// PX POS — user management for owners/admins (create cashier accounts, reset passwords, delete).
// Deploy: Supabase → Edge Functions → admin-users (verify JWT ON).
// Uses the built-in SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY secrets.
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const DOMAIN = "px-pos.app"; // usernames become <username>@px-pos.app (no email is ever sent)

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const caller = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: u } = await caller.auth.getUser();
    if (!u?.user) return json({ error: "Belum login" }, 401);
    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: me } = await admin.from("profiles").select("role,active").eq("id", u.user.id).single();
    if (!me?.active || !["owner", "admin"].includes(me.role)) return json({ error: "Hanya owner/admin" }, 403);

    const b = await req.json();
    const target = b.user_id
      ? (await admin.from("profiles").select("id,role").eq("id", b.user_id).single()).data
      : null;
    if (b.user_id && !target) return json({ error: "User tidak ditemukan" }, 404);
    if (target?.role === "owner" && me.role !== "owner") return json({ error: "Hanya owner yang boleh mengubah owner" }, 403);

    if (b.action === "create") {
      const username = String(b.username ?? "").trim().toLowerCase();
      const password = String(b.password ?? "");
      const role = ["admin", "cashier"].includes(b.role) ? b.role : "cashier";
      if (role === "admin" && me.role !== "owner") return json({ error: "Hanya owner yang boleh membuat admin" }, 403);
      if (!/^[a-z0-9._-]{3,30}$/.test(username)) return json({ error: "Username 3–30 karakter: huruf kecil, angka, . _ -" }, 400);
      if (password.length < 6) return json({ error: "Password minimal 6 karakter" }, 400);
      const { data, error } = await admin.auth.admin.createUser({
        email: `${username}@${DOMAIN}`,
        password,
        email_confirm: true,
        user_metadata: { full_name: String(b.full_name ?? username).slice(0, 80), username, role, active: true },
      });
      if (error) return json({ error: error.message.includes("already") ? "Username sudah dipakai" : error.message }, 400);
      // trigger created the profile; make sure fields are right even if it already existed
      await admin.from("profiles").update({ role, active: true, username, full_name: String(b.full_name ?? username).slice(0, 80) })
        .eq("id", data.user.id);
      return json({ ok: true, id: data.user.id });
    }

    if (b.action === "set_password") {
      if (String(b.password ?? "").length < 6) return json({ error: "Password minimal 6 karakter" }, 400);
      const { error } = await admin.auth.admin.updateUserById(b.user_id, { password: b.password });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    if (b.action === "delete") {
      if (b.user_id === u.user.id) return json({ error: "Tidak bisa menghapus akun sendiri" }, 400);
      const { count } = await admin.from("transactions").select("id", { count: "exact", head: true }).eq("cashier_id", b.user_id);
      if ((count ?? 0) > 0) {
        // keep history: deactivate instead of deleting
        // an inactive profile has no access at all (RLS); the account can be re-activated later
        await admin.from("profiles").update({ active: false }).eq("id", b.user_id);
        return json({ ok: true, deactivated: true });
      }
      const { error } = await admin.auth.admin.deleteUser(b.user_id);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    return json({ error: "Aksi tidak dikenal" }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
