const test = require("node:test");
const assert = require("node:assert/strict");
const {
  GoogleContactsDirectory,
  contactFromPerson,
  normalizePhoneNumber,
} = require("./contacts");

test("normalizes common US and international caller ID formats", () => {
  assert.equal(normalizePhoneNumber("(317) 555-0123"), "+13175550123");
  assert.equal(normalizePhoneNumber("1-317-555-0123"), "+13175550123");
  assert.equal(normalizePhoneNumber("+44 20 7946 0958"), "+442079460958");
  assert.equal(normalizePhoneNumber("0044 20 7946 0958"), "+442079460958");
  assert.equal(normalizePhoneNumber("317-555-0123 ext. 9"), "+13175550123");
});

test("extracts only the contact fields used by caller enrichment", () => {
  const contact = contactFromPerson(
    {
      resourceName: "people/123",
      names: [{ displayName: "Sarah Chen" }],
      nicknames: [{ value: "Sarah" }],
      phoneNumbers: [{ value: "(317) 555-0123" }],
      emailAddresses: [{ value: "sarah@example.com" }],
      organizations: [{ current: true, name: "Acme", title: "Owner" }],
      memberships: [
        { contactGroupMembership: { contactGroupResourceName: "contactGroups/clients" } },
      ],
    },
    new Map([["contactGroups/clients", "Clients"]]),
    "1"
  );

  assert.deepEqual(contact, {
    resourceName: "people/123",
    name: "Sarah Chen",
    nickname: "Sarah",
    phones: ["+13175550123"],
    emails: ["sarah@example.com"],
    organization: "Acme",
    title: "Owner",
    groups: ["Clients"],
  });
});

test("caller context is minimal and warns that caller ID is untrusted", () => {
  const directory = new GoogleContactsDirectory({
    clientId: "client",
    clientSecret: "secret",
    refreshToken: "refresh",
  });
  directory.contacts.set("people/123", {
    resourceName: "people/123",
    name: "Sarah Chen",
    nickname: "Sarah",
    phones: ["+13175550123"],
    emails: ["private@example.com"],
    organization: "Acme",
    title: "Owner",
    groups: ["Clients"],
  });
  directory.rebuildPhoneIndex();

  const context = directory.callerContext("3175550123");
  assert.match(context, /Sarah Chen/);
  assert.match(context, /Caller ID can be spoofed/);
  assert.doesNotMatch(context, /private@example\.com/);
  assert.equal(directory.callerContext("3175559999"), null);
});

test("performs a read-only People API sync and indexes contacts", async () => {
  const requested = [];
  const fetchImpl = async (url, options = {}) => {
    requested.push({ url: String(url), options });
    if (String(url).includes("oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({ access_token: "access", expires_in: 3600 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (String(url).includes("/contactGroups?")) {
      return new Response(
        JSON.stringify({
          contactGroups: [{ resourceName: "contactGroups/clients", name: "Clients" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response(
      JSON.stringify({
        connections: [
          {
            resourceName: "people/123",
            names: [{ displayName: "Sarah Chen" }],
            phoneNumbers: [{ canonicalForm: "+13175550123" }],
            memberships: [
              { contactGroupMembership: { contactGroupResourceName: "contactGroups/clients" } },
            ],
          },
        ],
        nextSyncToken: "next-token",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };
  const directory = new GoogleContactsDirectory({
    clientId: "client",
    clientSecret: "secret",
    refreshToken: "refresh",
    fetchImpl,
    logger: { log() {}, error() {} },
  });

  await directory.start();
  directory.stop();

  assert.equal(directory.syncToken, "next-token");
  assert.equal(directory.findByPhone("3175550123")[0].name, "Sarah Chen");
  assert.equal(requested[0].options.method, "POST");
  assert.match(requested[1].options.headers.Authorization, /^Bearer /);
});
