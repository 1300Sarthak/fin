import { deleteTrip, saveTrip, updateTrip, type TripInput } from "@/lib/travel";
import { handle, requireId } from "../_respond";

export const runtime = "nodejs";

export const POST = (req: Request) => handle(req, async (body) => saveTrip(body as TripInput));

export const PATCH = (req: Request) => handle(req, async ({ id, ...patch }) => ({ trip: await updateTrip(requireId({ id }), patch) }));

export const DELETE = (req: Request) => handle(req, async (body) => { await deleteTrip(requireId(body)); return {}; });
