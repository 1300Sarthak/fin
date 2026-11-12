import { deleteProgram, updateProgram, upsertProgram, type ProgramInput } from "@/lib/travel";
import { handle, requireId } from "../_respond";

export const runtime = "nodejs";

export const POST = (req: Request) => handle(req, async (body) => ({ program: await upsertProgram(body as ProgramInput) }));

export const PATCH = (req: Request) => handle(req, async ({ id, ...patch }) => ({ program: await updateProgram(requireId({ id }), patch) }));

export const DELETE = (req: Request) => handle(req, async (body) => { await deleteProgram(requireId(body)); return {}; });
