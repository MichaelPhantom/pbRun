/**
 * GET /api/activities/:id
 * Get single activity by ID.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getActivityById } from '@/app/lib/db';
import { parseIdParam } from '@/app/lib/query-params';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const parsed = parseIdParam(id);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  try {
    const activity = getActivityById(parsed.value);
    if (!activity) {
      return NextResponse.json({ error: 'Activity not found' }, { status: 404, headers: NO_STORE });
    }
    return NextResponse.json(activity, { headers: NO_STORE });
  } catch (error) {
    console.error('Error fetching activity:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500, headers: NO_STORE }
    );
  }
}
