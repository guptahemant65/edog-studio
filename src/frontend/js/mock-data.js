/**
 * MockData — Comprehensive mock data for EDOG Studio prototype.
 *
 * Provides realistic data for all 6 views + overlays so the UI
 * can be demonstrated without a live backend.
 *
 * Kael + Zara: This module loads first. Every view reads from here.
 */
const MockData = (() => {

  // ── Helpers ──
  const _uuid = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });

  const _ts = (minutesAgo) => {
    const d = new Date(Date.now() - minutesAgo * 60000);
    return d.toISOString();
  };

  const _shortTime = (minutesAgo) => {
    const d = new Date(Date.now() - minutesAgo * 60000);
    return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  // ── Workspaces ──
  const workspaces = [
    { id: _uuid(), displayName: 'EDOG-Dev-Workspace', type: 'Workspace', capacityId: 'cap-ppe-01', state: 'Active', description: 'Primary FLT development workspace' },
    { id: _uuid(), displayName: 'EDOG-Staging-Workspace', type: 'Workspace', capacityId: 'cap-ppe-02', state: 'Active', description: 'Staging environment for integration testing' },
    { id: _uuid(), displayName: 'Team-SharedWorkspace', type: 'Workspace', capacityId: 'cap-ppe-01', state: 'Active', description: 'Shared workspace for cross-team collaboration' },
    { id: _uuid(), displayName: 'Perf-Testing-WS', type: 'Workspace', capacityId: 'cap-ppe-03', state: 'Active', description: 'Performance and scale testing' },
  ];

  const _itemsForWorkspace = (wsIndex) => {
    const items = [
      [
        { id: _uuid(), displayName: 'TestLakehouse-01', type: 'Lakehouse', status: 'Active', lastModified: _ts(30) },
        { id: _uuid(), displayName: 'TestLakehouse-02', type: 'Lakehouse', status: 'Active', lastModified: _ts(120) },
        { id: _uuid(), displayName: 'SalesData-LH', type: 'Lakehouse', status: 'Active', lastModified: _ts(240) },
        { id: _uuid(), displayName: 'AnalysisNotebook', type: 'Notebook', status: 'Active', lastModified: _ts(360) },
        { id: _uuid(), displayName: 'DataPipeline-Refresh', type: 'DataPipeline', status: 'Active', lastModified: _ts(480) },
        { id: _uuid(), displayName: 'SalesReport-Q4', type: 'Report', status: 'Active', lastModified: _ts(600) },
        { id: _uuid(), displayName: 'MLExperiment-v3', type: 'MLExperiment', status: 'Active', lastModified: _ts(720) },
      ],
      [
        { id: _uuid(), displayName: 'Staging-Lakehouse', type: 'Lakehouse', status: 'Active', lastModified: _ts(60) },
        { id: _uuid(), displayName: 'Integration-Tests-LH', type: 'Lakehouse', status: 'Active', lastModified: _ts(180) },
        { id: _uuid(), displayName: 'Pipeline-Staging', type: 'DataPipeline', status: 'Active', lastModified: _ts(300) },
      ],
      [
        { id: _uuid(), displayName: 'SharedData-LH', type: 'Lakehouse', status: 'Active', lastModified: _ts(90) },
        { id: _uuid(), displayName: 'TeamNotebook-Shared', type: 'Notebook', status: 'Active', lastModified: _ts(200) },
        { id: _uuid(), displayName: 'KQL-Analytics', type: 'KQLDatabase', status: 'Active', lastModified: _ts(500) },
        { id: _uuid(), displayName: 'Warehouse-Main', type: 'Warehouse', status: 'Active', lastModified: _ts(800) },
      ],
      [
        { id: _uuid(), displayName: 'Perf-Lakehouse-Large', type: 'Lakehouse', status: 'Active', lastModified: _ts(45) },
        { id: _uuid(), displayName: 'LoadTest-Pipeline', type: 'DataPipeline', status: 'Active', lastModified: _ts(200) },
      ],
    ];
    return items[wsIndex] || items[0];
  };

  const tablesForLakehouse = [
    { name: 'sales_transactions', type: 'Delta', format: 'delta', location: 'Tables/sales_transactions', rowCount: 2847593, sizeBytes: 156000000 },
    { name: 'customer_dim', type: 'Delta', format: 'delta', location: 'Tables/customer_dim', rowCount: 48210, sizeBytes: 8400000 },
    { name: 'product_catalog', type: 'Delta', format: 'delta', location: 'Tables/product_catalog', rowCount: 12847, sizeBytes: 3200000 },
    { name: 'inventory_snapshot', type: 'Delta', format: 'delta', location: 'Tables/inventory_snapshot', rowCount: 385024, sizeBytes: 67000000 },
    { name: 'order_events', type: 'Delta', format: 'delta', location: 'Tables/order_events', rowCount: 9412837, sizeBytes: 412000000 },
    { name: 'raw_clickstream', type: 'Parquet', format: 'parquet', location: 'Files/raw/clickstream', rowCount: 52000000, sizeBytes: 2100000000 },
    { name: 'dq_metrics_history', type: 'Delta', format: 'delta', location: 'Tables/dq_metrics_history', rowCount: 156789, sizeBytes: 22000000 },
  ];

  const favorites = [
    { name: 'My Dev Lakehouse', workspaceName: 'EDOG-Dev-Workspace', lakehouseName: 'TestLakehouse-01' },
    { name: 'Team Staging', workspaceName: 'EDOG-Staging-Workspace', lakehouseName: 'Staging-Lakehouse' },
  ];

  // ── Log Entries ──
  const _components = ['DagExecutionHandler', 'SparkClient', 'OneLakeCatalog', 'TokenManager', 'RefreshEngine', 'MetastoreClient', 'DqMetricsWriter', 'ScheduleController'];
  const _logMessages = [
    { level: 'Message', comp: 'DagExecutionHandler', msg: 'Starting DAG execution for iteration {raid}' },
    { level: 'Message', comp: 'DagExecutionHandler', msg: 'Node "RefreshSalesData" completed successfully in 2.3s' },
    { level: 'Message', comp: 'DagExecutionHandler', msg: 'Node "TransformCustomerDim" started (parallel group 2)' },
    { level: 'Message', comp: 'DagExecutionHandler', msg: 'DAG execution completed: 8/8 nodes succeeded, 0 failed' },
    { level: 'Message', comp: 'SparkClient', msg: 'Spark session acquired (sessionId: spark-{uuid})' },
    { level: 'Message', comp: 'SparkClient', msg: 'Executing SQL: CREATE OR REPLACE MATERIALIZED VIEW sales_summary AS SELECT ...' },
    { level: 'Message', comp: 'SparkClient', msg: 'SQL execution completed in 4.7s, rows affected: 28475' },
    { level: 'Warning', comp: 'SparkClient', msg: 'Spark session approaching idle timeout (8min remaining)' },
    { level: 'Warning', comp: 'TokenManager', msg: 'MWC token expires in 12 minutes, scheduling refresh' },
    { level: 'Warning', comp: 'OneLakeCatalog', msg: 'Catalog listing returned partial results (timeout after 30s)' },
    { level: 'Error', comp: 'SparkClient', msg: 'MLV_SPARK_SESSION_ACQUISITION_FAILED: Cannot acquire Spark session — capacity throttled (429)' },
    { level: 'Error', comp: 'DagExecutionHandler', msg: 'Node "RefreshInventory" failed: NullReferenceException at OneLakeWriter.WriteAsync()' },
    { level: 'Error', comp: 'OneLakeCatalog', msg: 'Failed to list tables: HTTP 403 Forbidden — token scope insufficient' },
    { level: 'Verbose', comp: 'MetastoreClient', msg: 'Fetching table metadata for "sales_transactions" (cache miss)' },
    { level: 'Verbose', comp: 'DqMetricsWriter', msg: 'Writing DQ metrics batch: 12 records, 3.2KB' },
    { level: 'Verbose', comp: 'ScheduleController', msg: 'Schedule check: no pending executions' },
    { level: 'Message', comp: 'RefreshEngine', msg: 'Refresh policy evaluated: 3 tables need refresh (stale > 1h)' },
    { level: 'Message', comp: 'OneLakeCatalog', msg: 'Catalog listing completed: 7 tables, 2 shortcuts' },
    { level: 'Warning', comp: 'DagExecutionHandler', msg: 'Execution lock held for 4m30s — approaching stuck threshold' },
    { level: 'Error', comp: 'RefreshEngine', msg: 'MLV_DAG_NODE_EXECUTION_FAILED: Node "AggregateMetrics" — DeltaTableWriteException' },
    { level: 'Message', comp: 'TokenManager', msg: 'MWC token refreshed successfully (expires in 55 minutes)' },
    { level: 'Message', comp: 'SparkClient', msg: 'PUT /livyApi/versions/2024-04-18/sessions — 200 OK (1.2s)' },
    { level: 'Verbose', comp: 'RefreshEngine', msg: 'Evaluating node dependencies: TransformCustomerDim depends on [RefreshSalesData, RefreshCustomerRaw]' },
  ];

  function generateLogEntries(count) {
    const entries = [];
    const raidId = _uuid().split('-')[0];
    for (let i = 0; i < count; i++) {
      const template = _logMessages[Math.floor(Math.random() * _logMessages.length)];
      const minutesAgo = (count - i) * 0.15;
      entries.push({
        id: i + 1,
        timestamp: _shortTime(minutesAgo),
        isoTime: _ts(minutesAgo),
        level: template.level,
        component: template.comp,
        message: template.msg.replace('{raid}', raidId).replace('{uuid}', _uuid().substring(0, 8)),
        rootActivityId: i % 5 === 0 ? _uuid() : null,
        bookmarked: false,
      });
    }
    return entries;
  }

  // ── Capacities ──
  const capacities = [
    { id: 'cap-001', displayName: 'Dev Capacity F2', sku: 'F2', region: 'West US', state: 'Active' },
    { id: 'cap-002', displayName: 'Staging Capacity F4', sku: 'F4', region: 'East US', state: 'Active' },
    { id: 'cap-003', displayName: 'Production Capacity F64', sku: 'F64', region: 'West US', state: 'Active' },
  ];

  // ── DAG Nodes ──
  const dagNodes = [
    { nodeId: 'n1', name: 'RefreshSalesData', kind: 'sql', parents: [], children: ['n3', 'n4'], status: 'completed', duration: 2300, errorMessage: null, codeReference: { notebookId: 'nb-001', cellIndex: 0 } },
    { nodeId: 'n2', name: 'RefreshCustomerRaw', kind: 'sql', parents: [], children: ['n3'], status: 'completed', duration: 1800, errorMessage: null, codeReference: { notebookId: 'nb-001', cellIndex: 1 } },
    { nodeId: 'n3', name: 'TransformCustomerDim', kind: 'sql', parents: ['n1', 'n2'], children: ['n5', 'n6'], status: 'completed', duration: 4700, errorMessage: null, codeReference: { notebookId: 'nb-002', cellIndex: 0 } },
    { nodeId: 'n4', name: 'AggregateMetrics', kind: 'pyspark', parents: ['n1'], children: ['n7'], status: 'failed', duration: 12400, errorMessage: 'DeltaTableWriteException: Concurrent write conflict', codeReference: { notebookId: 'nb-003', cellIndex: 0 } },
    { nodeId: 'n5', name: 'BuildSalesSummary', kind: 'sql', parents: ['n3'], children: ['n8'], status: 'completed', duration: 3200, errorMessage: null, codeReference: { notebookId: 'nb-002', cellIndex: 1 } },
    { nodeId: 'n6', name: 'RefreshProductJoin', kind: 'sql', parents: ['n3'], children: ['n8'], status: 'completed', duration: 2100, errorMessage: null, codeReference: { notebookId: 'nb-002', cellIndex: 2 } },
    { nodeId: 'n7', name: 'WriteMetricsOutput', kind: 'pyspark', parents: ['n4'], children: [], status: 'skipped', duration: 0, errorMessage: 'Skipped: parent node failed', codeReference: null },
    { nodeId: 'n8', name: 'FinalizeViews', kind: 'sql', parents: ['n5', 'n6'], children: [], status: 'running', duration: null, errorMessage: null, codeReference: { notebookId: 'nb-004', cellIndex: 0 } },
  ];

  const dagEdges = [
    { from: 'n1', to: 'n3' }, { from: 'n1', to: 'n4' },
    { from: 'n2', to: 'n3' },
    { from: 'n3', to: 'n5' }, { from: 'n3', to: 'n6' },
    { from: 'n4', to: 'n7' },
    { from: 'n5', to: 'n8' }, { from: 'n6', to: 'n8' },
  ];

  const dagHistory = [
    { iterationId: _uuid().substring(0, 8), status: 'Running', duration: '1m 42s', total: 8, completed: 5, failed: 1, startTime: _shortTime(2) },
    { iterationId: _uuid().substring(0, 8), status: 'Succeeded', duration: '3m 12s', total: 8, completed: 8, failed: 0, startTime: _shortTime(35) },
    { iterationId: _uuid().substring(0, 8), status: 'Failed', duration: '2m 58s', total: 8, completed: 6, failed: 2, startTime: _shortTime(90) },
    { iterationId: _uuid().substring(0, 8), status: 'Succeeded', duration: '2m 45s', total: 8, completed: 8, failed: 0, startTime: _shortTime(180) },
    { iterationId: _uuid().substring(0, 8), status: 'Cancelled', duration: '0m 34s', total: 8, completed: 2, failed: 0, startTime: _shortTime(240) },
  ];

  // ── Mock notebook code (keyed by "notebookId:cellIndex") ──
  const mockCodeDefinitions = {
    'nb-001:0': 'CREATE OR REPLACE MATERIALIZED VIEW RefreshSalesData AS\nSELECT\n    s.region,\n    s.product_id,\n    p.product_name,\n    SUM(s.quantity) AS total_qty,\n    SUM(s.amount)   AS total_amount\nFROM sales_transactions s\nJOIN products p ON s.product_id = p.id\nGROUP BY s.region, s.product_id, p.product_name;',
    'nb-001:1': 'CREATE OR REPLACE MATERIALIZED VIEW RefreshCustomerRaw AS\nSELECT\n    customer_id,\n    first_name,\n    last_name,\n    email,\n    signup_date,\n    region\nFROM raw_customers\nWHERE is_active = 1;',
    'nb-002:0': 'CREATE OR REPLACE MATERIALIZED VIEW TransformCustomerDim AS\nSELECT\n    c.customer_id,\n    c.first_name || \' \' || c.last_name AS full_name,\n    c.email,\n    c.region,\n    COUNT(s.order_id)   AS order_count,\n    SUM(s.amount)       AS lifetime_value\nFROM RefreshCustomerRaw c\nLEFT JOIN RefreshSalesData s ON c.customer_id = s.customer_id\nGROUP BY c.customer_id, c.first_name, c.last_name, c.email, c.region;',
    'nb-002:1': 'CREATE OR REPLACE MATERIALIZED VIEW BuildSalesSummary AS\nSELECT\n    region,\n    DATE_TRUNC(\'month\', order_date) AS month,\n    COUNT(*)    AS order_count,\n    SUM(amount) AS revenue\nFROM TransformCustomerDim\nGROUP BY region, DATE_TRUNC(\'month\', order_date);',
    'nb-002:2': 'CREATE OR REPLACE MATERIALIZED VIEW RefreshProductJoin AS\nSELECT\n    p.product_id,\n    p.product_name,\n    p.category,\n    COALESCE(s.total_qty, 0)    AS units_sold,\n    COALESCE(s.total_amount, 0) AS revenue\nFROM products p\nLEFT JOIN RefreshSalesData s ON p.product_id = s.product_id;',
    'nb-003:0': '# PySpark: AggregateMetrics\nfrom pyspark.sql import functions as F\n\ndf = spark.table("TransformCustomerDim")\nagg = (\n    df.groupBy("region")\n      .agg(\n          F.count("customer_id").alias("customer_count"),\n          F.sum("lifetime_value").alias("total_ltv"),\n          F.avg("order_count").alias("avg_orders")\n      )\n)\nagg.write.format("delta").mode("overwrite").saveAsTable("aggregated_metrics")',
    'nb-004:0': 'CREATE OR REPLACE MATERIALIZED VIEW FinalizeViews AS\nSELECT\n    s.region,\n    s.month,\n    s.order_count,\n    s.revenue,\n    p.category,\n    p.units_sold\nFROM BuildSalesSummary s\nJOIN RefreshProductJoin p ON s.region = p.product_id;',
  };

  // ── Spark Requests ──
  const sparkRequests = [
    { id: 1, method: 'PUT', endpoint: '/livyApi/versions/2024-04-18/sessions', status: 200, duration: 1247, retries: 0, timestamp: _shortTime(5), body: '{ "kind": "sql", "conf": { "spark.lakehouse.id": "..." } }', response: '{ "id": 42, "state": "idle" }' },
    { id: 2, method: 'POST', endpoint: '/livyApi/versions/2024-04-18/sessions/42/statements', status: 200, duration: 4823, retries: 0, timestamp: _shortTime(4.5), body: 'CREATE OR REPLACE MATERIALIZED VIEW sales_summary AS\nSELECT region, SUM(amount) as total\nFROM sales_transactions\nGROUP BY region', response: '{ "id": 1, "state": "available", "output": { "status": "ok" } }' },
    { id: 3, method: 'GET', endpoint: '/livyApi/versions/2024-04-18/sessions/42/statements/1', status: 200, duration: 89, retries: 0, timestamp: _shortTime(4), body: null, response: '{ "id": 1, "state": "available", "output": { "status": "ok", "data": { "rows_affected": 28475 } } }' },
    { id: 4, method: 'POST', endpoint: '/livyApi/versions/2024-04-18/sessions/42/statements', status: 429, duration: 340, retries: 3, timestamp: _shortTime(3), body: 'CREATE OR REPLACE MATERIALIZED VIEW customer_360 AS ...', response: '{ "error": "TooManyRequests", "message": "Capacity throttled" }' },
    { id: 5, method: 'PUT', endpoint: '/livyApi/versions/2024-04-18/sessions', status: 200, duration: 2100, retries: 1, timestamp: _shortTime(2.5), body: '{ "kind": "pyspark" }', response: '{ "id": 43, "state": "idle" }' },
    { id: 6, method: 'DELETE', endpoint: '/livyApi/versions/2024-04-18/sessions/42', status: 200, duration: 312, retries: 0, timestamp: _shortTime(1), body: null, response: '{ "msg": "deleted" }' },
    { id: 7, method: 'POST', endpoint: '/livyApi/versions/2024-04-18/sessions/43/statements', status: 500, duration: 15234, retries: 2, timestamp: _shortTime(0.5), body: 'spark.sql("SELECT * FROM nonexistent_table")', response: '{ "error": "InternalServerError", "message": "Table not found: nonexistent_table" }' },
  ];

  // ── Feature Flags ──
  const featureFlags = [
    { name: 'FLTDagExecutionHandlerV2', description: 'V2 DAG execution orchestration', rings: { onebox: true, test: true, daily: true, cst: true, dxt: true, msit: false, prod: false }, override: null },
    { name: 'FLTParallelNodeLimit10', description: 'Set ParallelNodeLimit to 10', rings: { onebox: true, test: false, daily: false, cst: false, dxt: false, msit: false, prod: false }, override: null },
    { name: 'FLTParallelNodeLimit15', description: 'Set ParallelNodeLimit to 15', rings: { onebox: false, test: false, daily: false, cst: false, dxt: false, msit: false, prod: false }, override: null },
    { name: 'FLTArtifactBasedThrottling', description: 'Artifact-based throttling', rings: { onebox: true, test: true, daily: true, cst: true, dxt: true, msit: true, prod: 'conditional' }, override: null },
    { name: 'FLTUserBasedThrottling', description: 'User-based throttling', rings: { onebox: true, test: false, daily: false, cst: false, dxt: false, msit: false, prod: false }, override: null },
    { name: 'FLTIRDeletesDisabled', description: 'Disable IR deletes', rings: { onebox: true, test: true, daily: true, cst: false, dxt: false, msit: false, prod: false }, override: true },
    { name: 'FLTDqMetricsBatchWrite', description: 'Batch write for DQ metrics', rings: { onebox: true, test: 'conditional', daily: false, cst: false, dxt: false, msit: false, prod: false }, override: null },
    { name: 'FLTInsightsMetrics', description: 'Insights metrics collection', rings: { onebox: false, test: false, daily: false, cst: false, dxt: false, msit: false, prod: false }, override: null },
    { name: 'FLTUseOneLakeRegionalEndpoint', description: 'OneLake regional endpoint', rings: { onebox: true, test: true, daily: true, cst: true, dxt: true, msit: true, prod: true }, override: null },
    { name: 'FLTResilientCatalogListing', description: 'Resilient catalog with shortcut skip', rings: { onebox: true, test: true, daily: false, cst: false, dxt: false, msit: false, prod: false }, override: false },
    { name: 'FLTListPathOptimization', description: 'Delta list-path optimization', rings: { onebox: true, test: true, daily: true, cst: false, dxt: false, msit: false, prod: false }, override: null },
    { name: 'FLTDagSettings', description: 'DagSettings API', rings: { onebox: true, test: true, daily: false, cst: false, dxt: false, msit: false, prod: false }, override: null },
    { name: 'FLTMLVWarnings', description: 'RefreshPolicy/CDF warnings', rings: { onebox: true, test: true, daily: true, cst: true, dxt: false, msit: false, prod: false }, override: null },
    { name: 'FLTEnableRefreshTriggers', description: 'Event-based refresh triggers', rings: { onebox: true, test: false, daily: false, cst: false, dxt: false, msit: false, prod: false }, override: null },
    { name: 'FLTPublicApiSupport', description: 'Public API support', rings: { onebox: true, test: true, daily: true, cst: true, dxt: true, msit: true, prod: 'conditional' }, override: null },
    { name: 'FLTCapacityThrottlingAsUserError', description: 'Report capacity throttling as user error', rings: { onebox: true, test: true, daily: false, cst: false, dxt: false, msit: false, prod: false }, override: null },
  ];

  // ── API Playground Saved Requests ──
  const savedRequests = [
    { name: 'List Workspaces', method: 'GET', url: 'https://api.fabric.microsoft.com/v1/workspaces', group: 'Fabric' },
    { name: 'List Lakehouses', method: 'GET', url: 'https://api.fabric.microsoft.com/v1/workspaces/{workspaceId}/lakehouses', group: 'Fabric' },
    { name: 'List Tables', method: 'GET', url: 'https://api.fabric.microsoft.com/v1/workspaces/{workspaceId}/lakehouses/{lakehouseId}/tables', group: 'Fabric' },
    { name: 'Get Latest DAG', method: 'GET', url: '/liveTable/getLatestDag?showExtendedLineage=true', group: 'FLT' },
    { name: 'Run DAG', method: 'POST', url: '/liveTableSchedule/runDAG/{iterationId}', group: 'FLT' },
    { name: 'Cancel DAG', method: 'POST', url: '/liveTableSchedule/cancelDAG/{iterationId}', group: 'FLT' },
    { name: 'Get DAG Exec Status', method: 'GET', url: '/liveTableSchedule/getDAGExecStatus/{iterationId}', group: 'FLT' },
    { name: 'Force Unlock', method: 'POST', url: '/liveTableMaintenance/forceUnlockDAGExecution', group: 'Maintenance' },
    { name: 'List Orphaned Folders', method: 'GET', url: '/liveTableMaintenance/listOrphanedIndexFolders', group: 'Maintenance' },
  ];

  const apiHistory = [
    { method: 'GET', url: '/v1/workspaces', status: 200, duration: 342, timestamp: _shortTime(10) },
    { method: 'GET', url: '/v1/workspaces/.../lakehouses', status: 200, duration: 189, timestamp: _shortTime(9) },
    { method: 'GET', url: '/liveTable/getLatestDag?showExtendedLineage=true', status: 200, duration: 567, timestamp: _shortTime(5) },
    { method: 'POST', url: '/liveTableSchedule/runDAG/abc123', status: 202, duration: 234, timestamp: _shortTime(3) },
    { method: 'GET', url: '/liveTableSchedule/getDAGExecStatus/abc123', status: 200, duration: 78, timestamp: _shortTime(2) },
  ];

  // ── Token Info ──
  const tokenInfo = {
    bearer: {
      type: 'Bearer (AAD/Entra)',
      expiresIn: 42,
      issuedAt: _ts(18),
      expiresAt: _ts(-42),
      claims: {
        sub: 'hemant.gupta@microsoft.com',
        aud: 'https://api.fabric.microsoft.com',
        iss: 'https://sts.windows.net/72f988bf-86f1-41af-91ab-2d7cd011db47/',
        name: 'Hemant Gupta',
        oid: _uuid(),
        tid: '72f988bf-86f1-41af-91ab-2d7cd011db47',
        scp: 'Workspace.Read.All Workspace.ReadWrite.All Lakehouse.Read.All Item.ReadWrite.All',
      },
      scopes: ['Workspace.Read.All', 'Workspace.ReadWrite.All', 'Lakehouse.Read.All', 'Item.ReadWrite.All'],
    },
    mwc: {
      type: 'MWC (Workload)',
      expiresIn: 38,
      issuedAt: _ts(22),
      expiresAt: _ts(-38),
      claims: {
        sub: 'workload-fabriclivetable',
        aud: 'https://analysis.windows.net/powerbi/api',
        iss: 'https://login.microsoftonline.com',
        wl_tenantId: '72f988bf-86f1-41af-91ab-2d7cd011db47',
        wl_capacityId: _uuid(),
        wl_workspaceId: _uuid(),
        wl_artifactId: _uuid(),
      },
      scopes: ['Lakehouse.Execute', 'OneLake.ReadWrite', 'Notebook.Execute'],
    },
  };

  // ── Lock Monitor ──
  const lockState = {
    locked: true,
    holder: dagHistory[0].iterationId,
    lockedSince: _ts(2),
    age: '1m 42s',
  };

  // ── Orphaned Resources ──
  const orphanedFolders = [
    { path: 'Tables/.edog-index/sales_transactions/v12', size: '24.3 MB', age: '3 days' },
    { path: 'Tables/.edog-index/customer_dim/v8', size: '8.1 MB', age: '5 days' },
    { path: 'Tables/.edog-index/order_events/v3', size: '142.7 MB', age: '12 days' },
  ];

  // ── Config ──
  const config = {
    workspaceId: workspaces[0].id,
    artifactId: 'TestLakehouse-01',
    capacityId: 'cap-ppe-01',
    tenantId: '72f988bf-86f1-41af-91ab-2d7cd011db47',
    fabricBaseUrl: 'https://api.fabric.microsoft.com/v1',
    gitBranch: 'feature/dag-parallel-execution',
    patchCount: 6,
    uncommittedFiles: 3,
    tokenExpiryMinutes: 42,
    serviceStatus: 'running',
    phase: 'connected',
  };

  // ── Error Codes ──
  const errorCodes = {
    'MLV_SPARK_SESSION_ACQUISITION_FAILED': { message: 'Cannot acquire a Spark session for the lakehouse', type: 'System', fix: 'Check capacity CU usage. Retry after a few minutes or try a different capacity.' },
    'MLV_DAG_NODE_EXECUTION_FAILED': { message: 'A DAG node failed during execution', type: 'User/System', fix: 'Check node SQL for errors. Review Delta table write conflicts.' },
  };

  // Public API
  return {
    workspaces,
    getItemsForWorkspace: _itemsForWorkspace,
    tablesForLakehouse,
    favorites,
    generateLogEntries,
    dagNodes,
    dagEdges,
    dagHistory,
    capacities,
    mockCodeDefinitions,
    sparkRequests,
    featureFlags,
    savedRequests,
    apiHistory,
    tokenInfo,
    lockState,
    orphanedFolders,
    config,
    uuid: _uuid,
    errorCodes,
  };
})();
