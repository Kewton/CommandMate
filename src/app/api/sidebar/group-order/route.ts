/**
 * GET /api/sidebar/group-order  — retrieve saved repository group order
 * PUT /api/sidebar/group-order  — save repository group order
 */

import { NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { getSidebarGroupOrder, setSidebarGroupOrder } from '@/lib/db/app-settings-db';

export async function GET(): Promise<NextResponse> {
  try {
    const db = getDbInstance();
    const order = getSidebarGroupOrder(db);
    return NextResponse.json({ success: true, order });
  } catch (error) {
    console.error('GET /api/sidebar/group-order error:', error);
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}

export async function PUT(request: Request): Promise<NextResponse> {
  try {
    const body: unknown = await request.json();

    if (
      !body ||
      typeof body !== 'object' ||
      !('order' in body) ||
      !Array.isArray((body as { order: unknown }).order) ||
      !(body as { order: unknown[] }).order.every((v) => typeof v === 'string')
    ) {
      return NextResponse.json(
        { success: false, error: 'Invalid request body: order must be an array of strings' },
        { status: 400 }
      );
    }

    const order = (body as { order: string[] }).order;

    // Limit to prevent abuse
    if (order.length > 500) {
      return NextResponse.json(
        { success: false, error: 'Too many items in order array' },
        { status: 400 }
      );
    }

    const db = getDbInstance();
    setSidebarGroupOrder(db, order);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('PUT /api/sidebar/group-order error:', error);
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}
