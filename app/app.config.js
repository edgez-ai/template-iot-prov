const appName = process.env.APP_NAME;
const projectName = process.env.APPWRITE_PROJECT_NAME;
const domainSuffix = process.env.DOMAIN_SUFFIX;
const endpoint = process.env.APPWRITE_ENDPOINT;
const projectId = process.env.APPWRITE_PROJECT_ID;
const databaseId = process.env.DATABASE_ID;
const telemetryTableId = process.env.TELEMETRY_TABLE_ID;

if (!appName || !projectName || !domainSuffix || !endpoint || !projectId || !databaseId || !telemetryTableId) {
  throw new Error("Appwrite project and telemetry table environment is incomplete");
}

const bundlePrefix = domainSuffix.split(".").reverse().join(".");
const androidName = appName.replace(/[^A-Za-z0-9_]/g, "_").replace(/^[^A-Za-z_]+/, "app");
const platform = `${bundlePrefix}.${androidName}`;

module.exports = {
  expo: {
    name: appName,
    slug: appName,
    scheme: "edgez-devtools",
    version: "1.0.0",
    orientation: "portrait",
    userInterfaceStyle: "light",
    android: { package: platform },
    extra: {
      appwriteEndpoint: endpoint,
      appwriteProjectId: projectId,
      appwritePlatform: platform,
      databaseId,
      telemetryTableId,
    },
  },
};
