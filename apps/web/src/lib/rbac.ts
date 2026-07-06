import { NextResponse } from "next/server";
import { SessionData } from "./session";

// ── Permission constants ───────────────────────────────────────────────────────

export const Permission = {
  // Stone management
  STONE_VIEW:         "stone:view",
  STONE_CREATE:       "stone:create",
  STONE_ADVANCE:      "stone:advance",

  // Grading
  GRADE_VIEW:         "grade:view",
  GRADE_RUN:          "grade:run",
  GRADE_OVERRIDE:     "grade:override",

  // Pricing
  PRICE_VIEW:         "price:view",
  PRICE_ADJUST:       "price:adjust",
  PRICE_MARK_PRICED:  "price:mark_priced",

  // Catalog
  STONE_PUBLISH:      "stone:publish",
  CATALOG_MANAGE:     "catalog:manage",    // assign/refresh price books
  CATALOG_VIEW:       "catalog:view",      // buyer browsing their catalog

  // CRM
  INQUIRY_SUBMIT:     "inquiry:submit",   // buyer submits inquiry
  INQUIRY_MANAGE:     "inquiry:manage",   // sales/admin work the queue
  LIST_MANAGE:        "list:manage",      // create/edit shared lists

  // Admin
  AUDIT_VIEW:         "audit:view",
  USER_MANAGE:        "user:manage",

  // Billing (FR-12, BR-6)
  BILLING_VIEW:       "billing:view",    // view usage dashboard
  BILLING_MANAGE:     "billing:manage",  // initiate checkout / portal (admin only)
} as const;

export type Permission = typeof Permission[keyof typeof Permission];

// ── RBAC matrix ───────────────────────────────────────────────────────────────
// What each role is permitted to do across the Phase 1/2 stone and grading flows.

const ROLE_PERMISSIONS: Record<string, Set<Permission>> = {
  admin: new Set(Object.values(Permission)),

  grader: new Set([
    Permission.STONE_VIEW,
    Permission.STONE_CREATE,
    Permission.STONE_ADVANCE,
    Permission.GRADE_VIEW,
    Permission.GRADE_RUN,
    Permission.GRADE_OVERRIDE,
    Permission.PRICE_VIEW,
  ]),

  sales: new Set([
    Permission.STONE_VIEW,
    Permission.GRADE_VIEW,
    Permission.PRICE_VIEW,
    Permission.PRICE_ADJUST,
    Permission.PRICE_MARK_PRICED,
    Permission.STONE_PUBLISH,
    Permission.CATALOG_MANAGE,
    Permission.INQUIRY_MANAGE,
    Permission.LIST_MANAGE,
  ]),

  viewer: new Set([
    Permission.STONE_VIEW,
    Permission.GRADE_VIEW,
    Permission.PRICE_VIEW,
  ]),

  // Buyer: catalog-facing + CRM inquiry access only.
  buyer: new Set([
    Permission.CATALOG_VIEW,
    Permission.INQUIRY_SUBMIT,
  ]),
};

// ── Helpers ───────────────────────────────────────────────────────────────────

export function hasPermission(role: string, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.has(permission) ?? false;
}

/** Throws a NextResponse 403 if the session role lacks the required permission. */
export function requirePermission(
  session: SessionData,
  permission: Permission
): NextResponse | null {
  if (!hasPermission(session.role, permission)) {
    return NextResponse.json(
      { error: "Forbidden", required: permission, role: session.role },
      { status: 403 }
    );
  }
  return null;
}
