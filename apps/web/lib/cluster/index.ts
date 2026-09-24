// lib/cluster (SPEC section 3): the web app's entry point for the active cluster config.
// The config itself lives in @fstack/core (client-safe subpath, no node: imports) so the agreement template and COPY can use it too.
export {
  CLUSTERS,
  currentCluster,
  parseClusterName,
  explorerTxUrl,
  explorerAddressUrl,
  clusterRpcUrl,
  clusterAllowlistProgramId,
  clusterQuoteMint,
  type ClusterName,
  type ClusterConfig,
  type ClusterCopy,
} from "@fstack/core/src/cluster";
