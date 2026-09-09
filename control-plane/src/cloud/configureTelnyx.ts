import { tenants } from "../tenants";
import {
  assignNumberToConnection,
  createConnection,
  listPhoneNumbers,
} from "../telnyx";
import { webhookUrlForRuntime } from "./cloudStackEnv";

export type TelnyxConfigureResult = {
  connectionId: string;
  assignedDid: string | null;
  needsNumber: boolean;
  webhookUrl: string;
};

export async function configureTenantTelnyx(input: {
  tenantId: string;
  runtimeUrl: string;
}): Promise<TelnyxConfigureResult> {
  const webhookUrl = webhookUrlForRuntime(input.runtimeUrl);
  const connection = await createConnection(`vl-${input.tenantId}`.slice(0, 40), webhookUrl);
  const connectionId = connection.id;
  const dids = tenants.getOrCreate(input.tenantId).meta.numbers || [];
  const firstDid = dids[0] || null;
  if (!firstDid) {
    return { connectionId, assignedDid: null, needsNumber: true, webhookUrl };
  }
  const numbers = await listPhoneNumbers();
  const match = numbers.find(
    (n) => n.phone_number === firstDid || n.phone_number === `+${firstDid.replace(/^\+/, "")}`,
  );
  if (!match) {
    return { connectionId, assignedDid: null, needsNumber: true, webhookUrl };
  }
  await assignNumberToConnection(match.id, connectionId);
  return { connectionId, assignedDid: match.phone_number, needsNumber: false, webhookUrl };
}
