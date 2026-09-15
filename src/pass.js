import { PKPass } from "passkit-generator";
import { ICONS } from "./icons.js";

const b = (base64) => Buffer.from(base64, "base64");

/**
 * Builds a signed .pkpass for one person.
 * Needs these secrets/vars on the Worker:
 *   PASS_TYPE_ID, TEAM_ID  (plain vars, set in wrangler.jsonc or the dashboard)
 *   SIGNER_CERT_PEM, SIGNER_KEY_PEM, WWDR_PEM, SIGNER_KEY_PASSPHRASE (secrets)
 */
export async function buildPass(member, env) {
  const event = env.EVENT_NAME || "Teen Beach Moonta";
  const dates = env.EVENT_DATES || "2–5 October 2026";

  const passJson = {
    formatVersion: 1,
    passTypeIdentifier: env.PASS_TYPE_ID,
    teamIdentifier: env.TEAM_ID,
    organizationName: env.ORG_NAME || "Rover Scouts SA",
    description: event + " camp pass",
    serialNumber: member.code,
    logoText: event,
    foregroundColor: "rgb(255,255,255)",
    backgroundColor: "rgb(43,168,160)",
    labelColor: "rgb(255,210,63)",
    relevantDate: env.EVENT_START_ISO || "2026-10-02T09:00:00+09:30",
    eventTicket: {
      headerFields: [{ key: "code", label: "CODE", value: member.code }],
      primaryFields: [{ key: "name", label: "NAME", value: member.name }],
      secondaryFields: [{ key: "crew", label: "CREW", value: member.crew || env.ORG_NAME || "Rover Scouts SA" }],
      auxiliaryFields: [
        { key: "when", label: "WHEN", value: dates },
        { key: "where", label: "WHERE", value: env.EVENT_PLACE || "Moonta, SA" }
      ],
      backFields: [
        {
          key: "about",
          label: "How this works",
          value: "Show this pass at the check in desk whenever you leave site and again when you get back, so we always know who is where."
        },
        { key: "contact", label: "Questions", value: env.EVENT_EMAIL || "branchmoot@sarovers.com.au" }
      ]
    }
  };

  const pass = new PKPass(
    {
      "pass.json": Buffer.from(JSON.stringify(passJson)),
      "icon.png": b(ICONS.icon),
      "icon@2x.png": b(ICONS.icon2x),
      "icon@3x.png": b(ICONS.icon3x),
      "logo.png": b(ICONS.logo),
      "logo@2x.png": b(ICONS.logo2x),
      "thumbnail.png": b(ICONS.thumb),
      "thumbnail@2x.png": b(ICONS.thumb2x)
    },
    {
      wwdr: env.WWDR_PEM,
      signerCert: env.SIGNER_CERT_PEM,
      signerKey: env.SIGNER_KEY_PEM,
      signerKeyPassphrase: env.SIGNER_KEY_PASSPHRASE || undefined
    },
    { serialNumber: member.code }
  );

  pass.setBarcodes({
    format: "PKBarcodeFormatQR",
    message: member.code,
    messageEncoding: "iso-8859-1",
    altText: member.code
  });

  return pass.getAsBuffer();
}
