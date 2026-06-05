// AUTO-GENERATED from EdogErrorCodeCatalog.cs — do not edit manually
// Error codes: 115
var ERROR_SIM_CATALOG = [
  {
    "code": "MLV_TOO_MANY_REQUESTS",
    "phase": "GTS_SUBMIT",
    "channel": 2,
    "errorSource": "User",
    "category": "throttling",
    "nodeKinds": [
      "sql",
      "pyspark",
      "ingest"
    ],
    "description": "Request rate limit exceeded",
    "httpStatus": 429,
    "fltCodePath": "GTSBasedSparkClient.cs:488"
  },
  {
    "code": "MLV_SPARK_JOB_CAPACITY_THROTTLING",
    "phase": "GTS_SUBMIT",
    "channel": 2,
    "errorSource": "User",
    "category": "throttling",
    "nodeKinds": [
      "sql",
      "pyspark",
      "ingest"
    ],
    "description": "Capacity SKU exhausted",
    "httpStatus": 430,
    "fltCodePath": "GTSBasedSparkClient.cs:503"
  },
  {
    "code": "MLV_SPARK_SESSION_ACQUISITION_FAILED",
    "phase": "GTS_SUBMIT",
    "channel": 2,
    "errorSource": "System",
    "category": "execution",
    "nodeKinds": [
      "sql",
      "pyspark",
      "ingest"
    ],
    "description": "Spark session creation failed",
    "httpStatus": 500,
    "fltCodePath": "GTSBasedSparkClient.cs:489"
  },
  {
    "code": "MLV_SPARK_SESSION_REQUEST_SUBMISSION_FAILED",
    "phase": "GTS_SUBMIT",
    "channel": 2,
    "errorSource": "System",
    "category": "execution",
    "nodeKinds": [
      "sql",
      "pyspark",
      "ingest"
    ],
    "description": "Spark job submission rejected",
    "httpStatus": 400,
    "fltCodePath": "GTSBasedSparkClient.cs:524"
  },
  {
    "code": "MLV_SPARK_SESSION_ACQUISITION_TIMEOUT",
    "phase": "GTS_SUBMIT",
    "channel": 4,
    "errorSource": "System",
    "category": "execution",
    "nodeKinds": [
      "sql",
      "pyspark",
      "ingest"
    ],
    "description": "Spark session acquisition timed out",
    "httpStatus": 0,
    "fltCodePath": "GTSBasedSparkClient.cs:199"
  },
  {
    "code": "MLV_KNOWN_USER_ERROR",
    "phase": "GTS_SUBMIT",
    "channel": 2,
    "errorSource": "User",
    "category": "execution",
    "nodeKinds": [
      "sql",
      "pyspark",
      "ingest"
    ],
    "description": "User error passed through from GTS",
    "httpStatus": 400,
    "fltCodePath": "GTSBasedSparkClient.cs:517"
  },
  {
    "code": "MLV_TRANSFORM_EXECUTION_NOT_FOUND",
    "phase": "GTS_POLL",
    "channel": 1,
    "errorSource": "System",
    "category": "execution",
    "nodeKinds": [
      "sql",
      "pyspark",
      "ingest"
    ],
    "description": "Previously submitted transform ID not found on GTS",
    "httpStatus": 200,
    "fltCodePath": "GTSBasedSparkClient.cs:304"
  },
  {
    "code": "MLV_ACCESS_DENIED",
    "phase": "CATALOG_RESOLVE",
    "channel": 3,
    "errorSource": "User",
    "category": "auth",
    "nodeKinds": [
      "sql",
      "pyspark",
      "ingest"
    ],
    "description": "No permission to view lakehouse or table",
    "httpStatus": 0,
    "fltCodePath": "CatalogHandler.cs:129"
  },
  {
    "code": "MLV_UNAUTHORIZED_ACCESS",
    "phase": "CATALOG_RESOLVE",
    "channel": 3,
    "errorSource": "User",
    "category": "auth",
    "nodeKinds": [
      "sql",
      "pyspark",
      "ingest"
    ],
    "description": "Session missing required credentials",
    "httpStatus": 0,
    "fltCodePath": "ErrorRegistry"
  },
  {
    "code": "MLV_ENVIRONMENT_ACCESS_DENIED",
    "phase": "CATALOG_RESOLVE",
    "channel": 3,
    "errorSource": "User",
    "category": "auth",
    "nodeKinds": [
      "sql",
      "pyspark",
      "ingest"
    ],
    "description": "No permission to access configured environment",
    "httpStatus": 0,
    "fltCodePath": "ErrorRegistry"
  },
  {
    "code": "MLV_CATALOG_ACCESS_DENIED",
    "phase": "CATALOG_RESOLVE",
    "channel": 3,
    "errorSource": "User",
    "category": "auth",
    "nodeKinds": [
      "sql",
      "pyspark",
      "ingest"
    ],
    "description": "Catalog access denied",
    "httpStatus": 0,
    "fltCodePath": "ErrorRegistry"
  },
  {
    "code": "MLV_CATALOG_AUTHENTICATION_FAILED",
    "phase": "CATALOG_RESOLVE",
    "channel": 3,
    "errorSource": "System",
    "category": "auth",
    "nodeKinds": [
      "sql",
      "pyspark",
      "ingest"
    ],
    "description": "Authentication failure accessing catalog",
    "httpStatus": 0,
    "fltCodePath": "ErrorRegistry"
  },
  {
    "code": "MLV_ARTIFACT_NOT_FOUND",
    "phase": "CATALOG_RESOLVE",
    "channel": 3,
    "errorSource": "User",
    "category": "resource",
    "nodeKinds": [
      "sql",
      "pyspark",
      "ingest"
    ],
    "description": "Lakehouse no longer exists or can't be resolved",
    "httpStatus": 0,
    "fltCodePath": "CatalogHandler.cs:138"
  },
  {
    "code": "MLV_LAKEHOUSE_SOURCE_NOT_FOUND",
    "phase": "CATALOG_RESOLVE",
    "channel": 3,
    "errorSource": "User",
    "category": "resource",
    "nodeKinds": [
      "sql",
      "pyspark",
      "ingest"
    ],
    "description": "Source lakehouse not found or deleted",
    "httpStatus": 0,
    "fltCodePath": "ArtifactMetadataService.cs:59"
  },
  {
    "code": "MLV_NOTEBOOK_SOURCE_NOT_FOUND",
    "phase": "CATALOG_RESOLVE",
    "channel": 3,
    "errorSource": "User",
    "category": "resource",
    "nodeKinds": [
      "pyspark"
    ],
    "description": "Source notebook not found or deleted",
    "httpStatus": 0,
    "fltCodePath": "ErrorRegistry"
  },
  {
    "code": "MLV_SOURCE_ENTITY_NOT_FOUND",
    "phase": "CATALOG_RESOLVE",
    "channel": 3,
    "errorSource": "User",
    "category": "resource",
    "nodeKinds": [
      "sql",
      "pyspark",
      "ingest"
    ],
    "description": "Source entity missing or inaccessible",
    "httpStatus": 0,
    "fltCodePath": "CatalogHandler.cs:481"
  },
  {
    "code": "MLV_ENTITY_NOT_FOUND",
    "phase": "CATALOG_RESOLVE",
    "channel": 3,
    "errorSource": "User",
    "category": "resource",
    "nodeKinds": [
      "sql",
      "pyspark",
      "ingest"
    ],
    "description": "Referenced entity not found or inaccessible",
    "httpStatus": 0,
    "fltCodePath": "ErrorRegistry"
  },
  {
    "code": "MLV_SELECTED_NOT_FOUND",
    "phase": "CATALOG_RESOLVE",
    "channel": 3,
    "errorSource": "User",
    "category": "resource",
    "nodeKinds": [
      "sql",
      "pyspark"
    ],
    "description": "Selected MLVs not found in lakehouse",
    "httpStatus": 0,
    "fltCodePath": "CatalogHandler.cs:166"
  },
  {
    "code": "MLV_DATA_CORRUPTED",
    "phase": "CATALOG_RESOLVE",
    "channel": 3,
    "errorSource": "System",
    "category": "system",
    "nodeKinds": [
      "sql",
      "pyspark",
      "ingest"
    ],
    "description": "Catalog data corrupted or missing",
    "httpStatus": 0,
    "fltCodePath": "Dag.cs/CatalogHandler.cs"
  },
  {
    "code": "MLV_STALE_METADATA",
    "phase": "CATALOG_RESOLVE",
    "channel": 3,
    "errorSource": "System",
    "category": "resource",
    "nodeKinds": [
      "sql",
      "pyspark",
      "ingest"
    ],
    "description": "Stale metadata detected",
    "httpStatus": 0,
    "fltCodePath": "Node.cs:198"
  },
  {
    "code": "MLV_CROSS_WORKSPACE_NOT_SUPPORTED",
    "phase": "CATALOG_RESOLVE",
    "channel": 3,
    "errorSource": "User",
    "category": "validation",
    "nodeKinds": [
      "sql",
      "pyspark"
    ],
    "description": "Cross-workspace access not supported",
    "httpStatus": 0,
    "fltCodePath": "ErrorRegistry"
  },
  {
    "code": "MLV_ARTIFACT_REFERENCE_UNAVAILABLE",
    "phase": "CATALOG_RESOLVE",
    "channel": 3,
    "errorSource": "User",
    "category": "resource",
    "nodeKinds": [
      "sql",
      "pyspark"
    ],
    "description": "Unable to retrieve artifact reference",
    "httpStatus": 0,
    "fltCodePath": "ErrorRegistry"
  },
  {
    "code": "MLV_CIRCULAR_DEPENDENCY",
    "phase": "DAG_CONSTRUCTION",
    "channel": 3,
    "errorSource": "User",
    "category": "dag",
    "nodeKinds": [
      "sql",
      "pyspark"
    ],
    "description": "Circular dependency in lineage",
    "httpStatus": 0,
    "fltCodePath": "Dag.cs"
  },
  {
    "code": "MLV_LINEAGE_CREATION_FAILURE",
    "phase": "DAG_CONSTRUCTION",
    "channel": 3,
    "errorSource": "System",
    "category": "dag",
    "nodeKinds": [
      "sql",
      "pyspark",
      "ingest"
    ],
    "description": "Lineage creation failed",
    "httpStatus": 0,
    "fltCodePath": "LiveTableController.cs:213"
  },
  {
    "code": "MLV_LINEAGE_CREATION_NOTEBOOK_EXCEPTION",
    "phase": "DAG_CONSTRUCTION",
    "channel": 3,
    "errorSource": "System",
    "category": "dag",
    "nodeKinds": [
      "pyspark"
    ],
    "description": "Notebook exception during lineage creation",
    "httpStatus": 0,
    "fltCodePath": "LiveTableController.cs:288"
  },
  {
    "code": "MLV_LINEAGE_NOT_FOUND",
    "phase": "DAG_CONSTRUCTION",
    "channel": 3,
    "errorSource": "User",
    "category": "dag",
    "nodeKinds": [
      "sql",
      "pyspark",
      "ingest"
    ],
    "description": "Lineage information not found",
    "httpStatus": 0,
    "fltCodePath": "LiveTableHandler.cs:156"
  },
  {
    "code": "MLV_INVALID_FORMAT",
    "phase": "DAG_CONSTRUCTION",
    "channel": 3,
    "errorSource": "User",
    "category": "validation",
    "nodeKinds": [
      "sql",
      "pyspark"
    ],
    "description": "Table/view name not in supported format",
    "httpStatus": 0,
    "fltCodePath": "Node.cs"
  },
  {
    "code": "MLV_MAGIC_COMMAND_NOT_SUPPORTED",
    "phase": "DAG_CONSTRUCTION",
    "channel": 3,
    "errorSource": "User",
    "category": "validation",
    "nodeKinds": [
      "pyspark"
    ],
    "description": "Magic commands in notebook not supported",
    "httpStatus": 0,
    "fltCodePath": "NotebookExecutionContext.cs:186"
  },
  {
    "code": "MLV_MULTIPLE_DEFINITION_CONFLICT_SINGLE_CELL",
    "phase": "DAG_CONSTRUCTION",
    "channel": 3,
    "errorSource": "User",
    "category": "validation",
    "nodeKinds": [
      "pyspark"
    ],
    "description": "Multiple MLV definitions in single cell",
    "httpStatus": 0,
    "fltCodePath": "NotebookExecutionContext.cs:216"
  },
  {
    "code": "MLV_NB_ETAG_CHANGED",
    "phase": "DAG_CONSTRUCTION",
    "channel": 3,
    "errorSource": "User",
    "category": "concurrency",
    "nodeKinds": [
      "pyspark"
    ],
    "description": "Notebook changed after operation started",
    "httpStatus": 0,
    "fltCodePath": "ErrorRegistry"
  },
  {
    "code": "MLV_SETTINGS_FORMAT_ERROR",
    "phase": "PRE_EXECUTION_VALIDATION",
    "channel": 3,
    "errorSource": "User",
    "category": "validation",
    "nodeKinds": [
      "sql",
      "pyspark",
      "ingest"
    ],
    "description": "DAG settings corrupted",
    "httpStatus": 0,
    "fltCodePath": "DagExecutionHandlerV2.cs:260"
  },
  {
    "code": "MLV_SETTINGS_RETRIEVAL_ERROR",
    "phase": "PRE_EXECUTION_VALIDATION",
    "channel": 3,
    "errorSource": "System",
    "category": "validation",
    "nodeKinds": [
      "sql",
      "pyspark",
      "ingest"
    ],
    "description": "Settings retrieval failed",
    "httpStatus": 0,
    "fltCodePath": "DagExecutionHandlerV2.cs:266"
  },
  {
    "code": "MLV_DAG_HAS_FAULTED_NODES",
    "phase": "PRE_EXECUTION_VALIDATION",
    "channel": 3,
    "errorSource": "User",
    "category": "dag",
    "nodeKinds": [
      "sql",
      "pyspark",
      "ingest"
    ],
    "description": "DAG has faulted nodes from catalog resolution",
    "httpStatus": 0,
    "fltCodePath": "DagExecutionHandlerV2.cs:338"
  },
  {
    "code": "MLV_FABRIC_RUNTIME_VERSION_INCOMPATIBLE",
    "phase": "PRE_EXECUTION_VALIDATION",
    "channel": 3,
    "errorSource": "User",
    "category": "validation",
    "nodeKinds": [
      "sql",
      "pyspark"
    ],
    "description": "Incompatible Fabric runtime version",
    "httpStatus": 0,
    "fltCodePath": "ErrorRegistry"
  },
  {
    "code": "MLV_NOT_SUPPORTED",
    "phase": "PRE_EXECUTION_VALIDATION",
    "channel": 3,
    "errorSource": "User",
    "category": "validation",
    "nodeKinds": [
      "sql",
      "pyspark",
      "ingest"
    ],
    "description": "Feature not enabled for tenant",
    "httpStatus": 0,
    "fltCodePath": "ErrorRegistry"
  },
  {
    "code": "MLV_OPERATION_NOT_SUPPORTED",
    "phase": "PRE_EXECUTION_VALIDATION",
    "channel": 1,
    "errorSource": "User",
    "category": "validation",
    "nodeKinds": [
      "sql",
      "pyspark",
      "ingest"
    ],
    "description": "Operation not supported on MLV",
    "httpStatus": 200,
    "fltCodePath": "NodeExecutionUtils.cs:178"
  },
  {
    "code": "MLV_NOTEBOOK_CONTEXT_REQUIRED",
    "phase": "PRE_EXECUTION_VALIDATION",
    "channel": 1,
    "errorSource": "User",
    "category": "validation",
    "nodeKinds": [
      "pyspark"
    ],
    "description": "MLV requires Fabric Notebook context",
    "httpStatus": 200,
    "fltCodePath": "NodeExecutionUtils.cs:174"
  },
  {
    "code": "MLV_SOURCE_ENTRY_FUNCTION_REFERENCE_NOT_FOUND",
    "phase": "PRE_EXECUTION_VALIDATION",
    "channel": 1,
    "errorSource": "User",
    "category": "resource",
    "nodeKinds": [
      "pyspark"
    ],
    "description": "Source entry function reference not found",
    "httpStatus": 200,
    "fltCodePath": "NodeExecutionUtils.cs:176"
  },
  {
    "code": "MLV_INVALID",
    "phase": "PRE_EXECUTION_VALIDATION",
    "channel": 3,
    "errorSource": "User",
    "category": "validation",
    "nodeKinds": [
      "sql",
      "pyspark",
      "ingest"
    ],
    "description": "Invalid request parameters",
    "httpStatus": 0,
    "fltCodePath": "ErrorRegistry"
  },
  {
    "code": "MLV_MV_NOT_FOUND",
    "phase": "NODE_EXECUTION",
    "channel": 1,
    "errorSource": "User",
    "category": "resource",
    "nodeKinds": [
      "sql",
      "pyspark"
    ],
    "description": "Materialized view not found",
    "httpStatus": 200,
    "fltCodePath": "NodeExecutionUtils.cs:127"
  },
  {
    "code": "MLV_NOT_FOUND",
    "phase": "NODE_EXECUTION",
    "channel": 1,
    "errorSource": "User",
    "category": "resource",
    "nodeKinds": [
      "sql",
      "pyspark"
    ],
    "description": "Materialized view not found (generic)",
    "httpStatus": 200,
    "fltCodePath": "NodeExecutionUtils.cs:161"
  },
  {
    "code": "MLV_CONCURRENT_REFRESH",
    "phase": "NODE_EXECUTION",
    "channel": 1,
    "errorSource": "User",
    "category": "concurrency",
    "nodeKinds": [
      "sql",
      "pyspark",
      "ingest"
    ],
    "description": "Concurrent write conflict",
    "httpStatus": 200,
    "fltCodePath": "NodeExecutionUtils.cs:138"
  },
  {
    "code": "MLV_REFRESH_CONFLICT",
    "phase": "NODE_EXECUTION",
    "channel": 1,
    "errorSource": "User",
    "category": "concurrency",
    "nodeKinds": [
      "sql",
      "pyspark",
      "ingest"
    ],
    "description": "Concurrent write occurred",
    "httpStatus": 200,
    "fltCodePath": "NodeExecutionUtils.cs:154"
  },
  {
    "code": "MLV_REFRESH_WRITE_FAILED",
    "phase": "NODE_EXECUTION",
    "channel": 1,
    "errorSource": "System",
    "category": "execution",
    "nodeKinds": [
      "sql",
      "pyspark",
      "ingest"
    ],
    "description": "Write operation failed",
    "httpStatus": 200,
    "fltCodePath": "ErrorRegistry"
  },
  {
    "code": "MLV_REFRESH_SOURCE_ENTITIES_UNDEFINED",
    "phase": "NODE_EXECUTION",
    "channel": 1,
    "errorSource": "User",
    "category": "validation",
    "nodeKinds": [
      "sql",
      "pyspark"
    ],
    "description": "Source entities field undefined",
    "httpStatus": 200,
    "fltCodePath": "ErrorRegistry"
  },
  {
    "code": "MLV_REFRESH_SOURCE_ENTITIES_CORRUPTED",
    "phase": "NODE_EXECUTION",
    "channel": 1,
    "errorSource": "System",
    "category": "system",
    "nodeKinds": [
      "sql",
      "pyspark"
    ],
    "description": "Source entity information corrupted",
    "httpStatus": 200,
    "fltCodePath": "ErrorRegistry"
  },
  {
    "code": "MLV_REFRESH_DEFAULT_DB_UNDEFINED",
    "phase": "NODE_EXECUTION",
    "channel": 1,
    "errorSource": "User",
    "category": "validation",
    "nodeKinds": [
      "sql",
      "pyspark"
    ],
    "description": "Default database not defined",
    "httpStatus": 200,
    "fltCodePath": "ErrorRegistry"
  },
  {
    "code": "MLV_REFRESH_VIEW_TEXT_NOT_FOUND",
    "phase": "NODE_EXECUTION",
    "channel": 1,
    "errorSource": "User",
    "category": "validation",
    "nodeKinds": [
      "sql",
      "pyspark"
    ],
    "description": "ViewText field missing or corrupted",
    "httpStatus": 200,
    "fltCodePath": "NodeExecutionUtils.cs:140"
  },
  {
    "code": "MLV_SOURCE_ENTITIES_MISSING",
    "phase": "NODE_EXECUTION",
    "channel": 1,
    "errorSource": "User",
    "category": "resource",
    "nodeKinds": [
      "sql",
      "pyspark"
    ],
    "description": "Required source entities missing",
    "httpStatus": 200,
    "fltCodePath": "NodeExecutionUtils.cs:130/180"
  },
  {
    "code": "MLV_SOURCE_DB_MISSING",
    "phase": "NODE_EXECUTION",
    "channel": 1,
    "errorSource": "User",
    "category": "resource",
    "nodeKinds": [
      "sql",
      "pyspark"
    ],
    "description": "Specified database entity not found",
    "httpStatus": 200,
    "fltCodePath": "NodeExecutionUtils.cs:131"
  },
  {
    "code": "MLV_QUERY_NOT_FOUND",
    "phase": "NODE_EXECUTION",
    "channel": 1,
    "errorSource": "User",
    "category": "validation",
    "nodeKinds": [
      "sql",
      "pyspark"
    ],
    "description": "ViewText missing/corrupted",
    "httpStatus": 200,
    "fltCodePath": "NodeExecutionUtils.cs:162"
  },
  {
    "code": "MLV_SCHEMA_NOT_FOUND",
    "phase": "NODE_EXECUTION",
    "channel": 1,
    "errorSource": "User",
    "category": "schema",
    "nodeKinds": [
      "sql",
      "pyspark"
    ],
    "description": "Default database not defined",
    "httpStatus": 200,
    "fltCodePath": "NodeExecutionUtils.cs:163"
  },
  {
    "code": "MLV_SOURCE_ENTITY_CORRUPTED",
    "phase": "NODE_EXECUTION",
    "channel": 1,
    "errorSource": "User",
    "category": "system",
    "nodeKinds": [
      "sql",
      "pyspark"
    ],
    "description": "Source entity information corrupted",
    "httpStatus": 200,
    "fltCodePath": "NodeExecutionUtils.cs:165"
  },
  {
    "code": "MLV_INVALID_OBJECT_TYPE",
    "phase": "NODE_EXECUTION",
    "channel": 1,
    "errorSource": "User",
    "category": "validation",
    "nodeKinds": [
      "sql",
      "pyspark"
    ],
    "description": "Entity is not a materialized view",
    "httpStatus": 200,
    "fltCodePath": "NodeExecutionUtils.cs:166"
  },
  {
    "code": "MLV_NOT_A_TABLE",
    "phase": "NODE_EXECUTION",
    "channel": 1,
    "errorSource": "User",
    "category": "validation",
    "nodeKinds": [
      "sql",
      "pyspark"
    ],
    "description": "Operation not supported on MLV",
    "httpStatus": 200,
    "fltCodePath": "NodeExecutionUtils.cs:167"
  },
  {
    "code": "MLV_NOT_A_MATERIALIZED_VIEW",
    "phase": "NODE_EXECUTION",
    "channel": 1,
    "errorSource": "User",
    "category": "validation",
    "nodeKinds": [
      "sql",
      "pyspark"
    ],
    "description": "Entity is not a materialized view",
    "httpStatus": 200,
    "fltCodePath": "NodeExecutionUtils.cs:129"
  },
  {
    "code": "DELTA_TABLE_NOT_FOUND",
    "phase": "NODE_EXECUTION",
    "channel": 1,
    "errorSource": "User",
    "category": "resource",
    "nodeKinds": [
      "sql",
      "pyspark"
    ],
    "description": "Delta table not found",
    "httpStatus": 200,
    "fltCodePath": "NodeExecutionUtils.cs:128"
  },
  {
    "code": "MLV_CONSTRAINT_VIOLATION",
    "phase": "NODE_EXECUTION",
    "channel": 1,
    "errorSource": "User",
    "category": "constraint",
    "nodeKinds": [
      "sql",
      "pyspark"
    ],
    "description": "Constraint violation",
    "httpStatus": 200,
    "fltCodePath": "NodeExecutionUtils.cs:155"
  },
  {
    "code": "MLV_CONSTRAINT_VIOLATION_EXCEPTION",
    "phase": "NODE_EXECUTION",
    "channel": 1,
    "errorSource": "User",
    "category": "constraint",
    "nodeKinds": [
      "sql",
      "pyspark"
    ],
    "description": "Constraint violation exception",
    "httpStatus": 200,
    "fltCodePath": "NodeExecutionUtils.cs:136"
  },
  {
    "code": "MLV_CONSTRAINT_NON_BOOLEAN",
    "phase": "NODE_EXECUTION",
    "channel": 1,
    "errorSource": "User",
    "category": "constraint",
    "nodeKinds": [
      "sql",
      "pyspark"
    ],
    "description": "Constraint does not evaluate to boolean",
    "httpStatus": 200,
    "fltCodePath": "NodeExecutionUtils.cs:141"
  },
  {
    "code": "MLV_CONSTRAINT_NOT_BOOLEAN",
    "phase": "NODE_EXECUTION",
    "channel": 1,
    "errorSource": "User",
    "category": "constraint",
    "nodeKinds": [
      "sql",
      "pyspark"
    ],
    "description": "Constraint does not evaluate to boolean",
    "httpStatus": 200,
    "fltCodePath": "NodeExecutionUtils.cs:157"
  },
  {
    "code": "MLV_CONSTRAINT_NON_DETERMINISTIC",
    "phase": "NODE_EXECUTION",
    "channel": 1,
    "errorSource": "User",
    "category": "constraint",
    "nodeKinds": [
      "sql",
      "pyspark"
    ],
    "description": "Constraint uses non-deterministic functions",
    "httpStatus": 200,
    "fltCodePath": "NodeExecutionUtils.cs:156"
  },
  {
    "code": "MLV_CONSTRAINT_SCHEMA_VIOLATION",
    "phase": "NODE_EXECUTION",
    "channel": 1,
    "errorSource": "User",
    "category": "constraint",
    "nodeKinds": [
      "sql",
      "pyspark"
    ],
    "description": "Constraint references non-existent columns",
    "httpStatus": 200,
    "fltCodePath": "NodeExecutionUtils.cs:158"
  },
  {
    "code": "MLV_CONSTRAINT_UDF_NOT_SUPPORTED",
    "phase": "NODE_EXECUTION",
    "channel": 1,
    "errorSource": "User",
    "category": "constraint",
    "nodeKinds": [
      "sql",
      "pyspark"
    ],
    "description": "Unsupported constraint",
    "httpStatus": 200,
    "fltCodePath": "NodeExecutionUtils.cs:159"
  },
  {
    "code": "MLV_CONSTRAINT_MISMATCH",
    "phase": "NODE_EXECUTION",
    "channel": 1,
    "errorSource": "User",
    "category": "constraint",
    "nodeKinds": [
      "sql",
      "pyspark"
    ],
    "description": "Constraint mismatch",
    "httpStatus": 200,
    "fltCodePath": "NodeExecutionUtils.cs:173"
  },
  {
    "code": "MLV_SCHEMA_MISMATCH",
    "phase": "NODE_EXECUTION",
    "channel": 1,
    "errorSource": "User",
    "category": "schema",
    "nodeKinds": [
      "sql",
      "pyspark"
    ],
    "description": "Schema mismatch during refresh",
    "httpStatus": 200,
    "fltCodePath": "NodeExecutionUtils.cs:170"
  },
  {
    "code": "MLV_SOURCE_ENTITY_MISMATCH",
    "phase": "NODE_EXECUTION",
    "channel": 1,
    "errorSource": "User",
    "category": "schema",
    "nodeKinds": [
      "sql",
      "pyspark"
    ],
    "description": "Source entity mismatch during refresh",
    "httpStatus": 200,
    "fltCodePath": "NodeExecutionUtils.cs:169"
  },
  {
    "code": "MLV_TABLE_PROPERTIES_MISMATCH",
    "phase": "NODE_EXECUTION",
    "channel": 1,
    "errorSource": "User",
    "category": "schema",
    "nodeKinds": [
      "sql",
      "pyspark"
    ],
    "description": "Table properties changed",
    "httpStatus": 200,
    "fltCodePath": "NodeExecutionUtils.cs:171"
  },
  {
    "code": "MLV_PARTITION_MISMATCH",
    "phase": "NODE_EXECUTION",
    "channel": 1,
    "errorSource": "User",
    "category": "schema",
    "nodeKinds": [
      "sql",
      "pyspark"
    ],
    "description": "Partition columns changed",
    "httpStatus": 200,
    "fltCodePath": "NodeExecutionUtils.cs:172"
  },
  {
    "code": "MLV_CATALOG_WRITE_FAILED",
    "phase": "NODE_EXECUTION",
    "channel": 1,
    "errorSource": "User",
    "category": "execution",
    "nodeKinds": [
      "sql",
      "pyspark"
    ],
    "description": "Catalog metadata write failed",
    "httpStatus": 200,
    "fltCodePath": "NodeExecutionUtils.cs:160"
  },
  {
    "code": "MLV_COLUMN_DQ_CHECK_FAILED",
    "phase": "NODE_EXECUTION",
    "channel": 1,
    "errorSource": "User",
    "category": "dq",
    "nodeKinds": [
      "sql",
      "pyspark"
    ],
    "description": "Data quality check failed",
    "httpStatus": 200,
    "fltCodePath": "DqCheckNodeHook.cs:83"
  },
  {
    "code": "MLV_ALREADY_EXISTS",
    "phase": "NODE_EXECUTION",
    "channel": 1,
    "errorSource": "User",
    "category": "concurrency",
    "nodeKinds": [
      "sql",
      "pyspark"
    ],
    "description": "MLV already exists",
    "httpStatus": 200,
    "fltCodePath": "NodeExecutionUtils.cs:153"
  },
  {
    "code": "MLV_SAVEASTABLE_NOT_ALLOWED",
    "phase": "NODE_EXECUTION",
    "channel": 1,
    "errorSource": "User",
    "category": "validation",
    "nodeKinds": [
      "sql",
      "pyspark"
    ],
    "description": "saveAsTable not allowed on MLV",
    "httpStatus": 200,
    "fltCodePath": "NodeExecutionUtils.cs:152"
  },
  {
    "code": "MLV_UNCLASSIFIED_SYSTEM_ERROR",
    "phase": "NODE_EXECUTION",
    "channel": 1,
    "errorSource": "System",
    "category": "system",
    "nodeKinds": [
      "sql",
      "pyspark",
      "ingest"
    ],
    "description": "Unclassified system error",
    "httpStatus": 200,
    "fltCodePath": "NodeExecutionUtils.cs:115"
  },
  {
    "code": "MLV_UNKNOWN_ERROR",
    "phase": "NODE_EXECUTION",
    "channel": 1,
    "errorSource": "System",
    "category": "system",
    "nodeKinds": [
      "sql",
      "pyspark",
      "ingest"
    ],
    "description": "Unknown error",
    "httpStatus": 200,
    "fltCodePath": "NodeExecutionUtils.cs:118"
  },
  {
    "code": "MLV_ERROR_CODE_NOT_FOUND",
    "phase": "NODE_EXECUTION",
    "channel": 1,
    "errorSource": "System",
    "category": "system",
    "nodeKinds": [
      "sql",
      "pyspark",
      "ingest"
    ],
    "description": "Error code not found in registry",
    "httpStatus": 200,
    "fltCodePath": "NodeExecutor.cs:152"
  },
  {
    "code": "MLV_SYSTEM_ERROR",
    "phase": "NODE_EXECUTION",
    "channel": 1,
    "errorSource": "System",
    "category": "system",
    "nodeKinds": [
      "sql",
      "pyspark",
      "ingest"
    ],
    "description": "System error",
    "httpStatus": 200,
    "fltCodePath": "ErrorRegistry"
  },
  {
    "code": "MLV_INTERNAL_SERVER_ERROR",
    "phase": "NODE_EXECUTION",
    "channel": 1,
    "errorSource": "System",
    "category": "system",
    "nodeKinds": [
      "sql",
      "pyspark",
      "ingest"
    ],
    "description": "Internal server error",
    "httpStatus": 200,
    "fltCodePath": "ErrorRegistry"
  },
  {
    "code": "MLV_RUNTIME_ERROR",
    "phase": "NODE_EXECUTION",
    "channel": 1,
    "errorSource": "System",
    "category": "execution",
    "nodeKinds": [
      "sql",
      "pyspark",
      "ingest"
    ],
    "description": "Failed to execute MLV",
    "httpStatus": 200,
    "fltCodePath": "NodeExecutionUtils.cs:177"
  },
  {
    "code": "MLV_INVALID_SYNTAX_PYSPARK",
    "phase": "NODE_EXECUTION",
    "channel": 1,
    "errorSource": "User",
    "category": "pyspark",
    "nodeKinds": [
      "pyspark"
    ],
    "description": "Invalid PySpark syntax",
    "httpStatus": 200,
    "fltCodePath": "NodeExecutionUtils.cs:134"
  },
  {
    "code": "MLV_LIBRARY_MODULE_UNAVAILABLE",
    "phase": "NODE_EXECUTION",
    "channel": 1,
    "errorSource": "User",
    "category": "pyspark",
    "nodeKinds": [
      "pyspark"
    ],
    "description": "Required library/module missing",
    "httpStatus": 200,
    "fltCodePath": "NodeExecutionUtils.cs:135"
  },
  {
    "code": "MLV_PYSPARK_REFRESH_SOURCE_ENTITIES_MISMATCH",
    "phase": "NODE_EXECUTION",
    "channel": 1,
    "errorSource": "User",
    "category": "pyspark",
    "nodeKinds": [
      "pyspark"
    ],
    "description": "Source entities mismatch in PySpark refresh",
    "httpStatus": 200,
    "fltCodePath": "NodeExecutionUtils.cs:142"
  },
  {
    "code": "MLV_PYSPARK_REFRESH_SCHEMA_MISMATCH",
    "phase": "NODE_EXECUTION",
    "channel": 1,
    "errorSource": "User",
    "category": "pyspark",
    "nodeKinds": [
      "pyspark"
    ],
    "description": "Schema mismatch in PySpark refresh",
    "httpStatus": 200,
    "fltCodePath": "NodeExecutionUtils.cs:143"
  },
  {
    "code": "MLV_PYSPARK_REFRESH_DQ_MISMATCH",
    "phase": "NODE_EXECUTION",
    "channel": 1,
    "errorSource": "User",
    "category": "pyspark",
    "nodeKinds": [
      "pyspark"
    ],
    "description": "DQ mismatch in PySpark refresh",
    "httpStatus": 200,
    "fltCodePath": "NodeExecutionUtils.cs:144"
  },
  {
    "code": "MLV_PYSPARK_CREATION_NOT_FROM_NOTEBOOK",
    "phase": "NODE_EXECUTION",
    "channel": 1,
    "errorSource": "User",
    "category": "pyspark",
    "nodeKinds": [
      "pyspark"
    ],
    "description": "PySpark MLV not created from notebook",
    "httpStatus": 200,
    "fltCodePath": "NodeExecutionUtils.cs:145"
  },
  {
    "code": "MLV_NOT_A_PYSPARK_MLV",
    "phase": "NODE_EXECUTION",
    "channel": 1,
    "errorSource": "User",
    "category": "pyspark",
    "nodeKinds": [
      "pyspark"
    ],
    "description": "MLV is not a PySpark MLV",
    "httpStatus": 200,
    "fltCodePath": "NodeExecutionUtils.cs:146"
  },
  {
    "code": "MLV_NOT_A_SQL_MLV",
    "phase": "NODE_EXECUTION",
    "channel": 1,
    "errorSource": "User",
    "category": "validation",
    "nodeKinds": [
      "sql"
    ],
    "description": "MLV is not a SQL MLV",
    "httpStatus": 200,
    "fltCodePath": "NodeExecutionUtils.cs:147/151"
  },
  {
    "code": "MLV_PYSPARK_MISSING_SOURCE_ENTRY_FUNCTION",
    "phase": "NODE_EXECUTION",
    "channel": 1,
    "errorSource": "System",
    "category": "pyspark",
    "nodeKinds": [
      "pyspark"
    ],
    "description": "Missing source entry function",
    "httpStatus": 200,
    "fltCodePath": "NodeExecutionUtils.cs:116"
  },
  {
    "code": "MLV_PYSPARK_MISSING_SOURCE_NOTEBOOK_ID",
    "phase": "NODE_EXECUTION",
    "channel": 1,
    "errorSource": "System",
    "category": "pyspark",
    "nodeKinds": [
      "pyspark"
    ],
    "description": "Missing source notebook ID",
    "httpStatus": 200,
    "fltCodePath": "NodeExecutionUtils.cs:117"
  },
  {
    "code": "MLV_PYSPARK_MISSING_SOURCE_WORKSPACE_ID",
    "phase": "NODE_EXECUTION",
    "channel": 1,
    "errorSource": "System",
    "category": "pyspark",
    "nodeKinds": [
      "pyspark"
    ],
    "description": "Missing source workspace ID",
    "httpStatus": 200,
    "fltCodePath": "NodeExecutionUtils.cs:119"
  },
  {
    "code": "MLV_CONSTRAINT_MISMATCH_PYSPARK",
    "phase": "NODE_EXECUTION",
    "channel": 1,
    "errorSource": "User",
    "category": "pyspark",
    "nodeKinds": [
      "pyspark"
    ],
    "description": "Constraint mismatch in PySpark",
    "httpStatus": 200,
    "fltCodePath": "NodeExecutionUtils.cs:148"
  },
  {
    "code": "MLV_SCHEMA_MISMATCH_PYSPARK",
    "phase": "NODE_EXECUTION",
    "channel": 1,
    "errorSource": "User",
    "category": "pyspark",
    "nodeKinds": [
      "pyspark"
    ],
    "description": "Schema mismatch in PySpark",
    "httpStatus": 200,
    "fltCodePath": "NodeExecutionUtils.cs:149"
  },
  {
    "code": "MLV_SOURCE_ENTITY_MISMATCH_PYSPARK",
    "phase": "NODE_EXECUTION",
    "channel": 1,
    "errorSource": "User",
    "category": "pyspark",
    "nodeKinds": [
      "pyspark"
    ],
    "description": "Source entity mismatch in PySpark",
    "httpStatus": 200,
    "fltCodePath": "NodeExecutionUtils.cs:150"
  },
  {
    "code": "MLV_INGEST_PATH_NOT_FOUND",
    "phase": "INGEST",
    "channel": 1,
    "errorSource": "User",
    "category": "ingest",
    "nodeKinds": [
      "ingest"
    ],
    "description": "Source path does not exist",
    "httpStatus": 200,
    "fltCodePath": "FileIngestionError.cs"
  },
  {
    "code": "MLV_INGEST_UNABLE_TO_INFER_SCHEMA",
    "phase": "INGEST",
    "channel": 1,
    "errorSource": "User",
    "category": "ingest",
    "nodeKinds": [
      "ingest"
    ],
    "description": "Cannot infer schema from source files",
    "httpStatus": 200,
    "fltCodePath": "FileIngestionError.cs"
  },
  {
    "code": "MLV_INGEST_SCHEMA_DRIFT_REJECTED",
    "phase": "INGEST",
    "channel": 1,
    "errorSource": "User",
    "category": "ingest",
    "nodeKinds": [
      "ingest"
    ],
    "description": "Schema drift detected in FIXED mode",
    "httpStatus": 200,
    "fltCodePath": "FileIngestionError.cs"
  },
  {
    "code": "MLV_INGEST_INCOMPATIBLE_TYPE",
    "phase": "INGEST",
    "channel": 1,
    "errorSource": "User",
    "category": "ingest",
    "nodeKinds": [
      "ingest"
    ],
    "description": "Unsafe type narrowing detected",
    "httpStatus": 200,
    "fltCodePath": "FileIngestionError.cs"
  },
  {
    "code": "MLV_INGEST_CORRUPT_RECORDS",
    "phase": "INGEST",
    "channel": 1,
    "errorSource": "User",
    "category": "ingest",
    "nodeKinds": [
      "ingest"
    ],
    "description": "Malformed data in source file",
    "httpStatus": 200,
    "fltCodePath": "FileIngestionError.cs"
  },
  {
    "code": "MLV_INGEST_DELTA_WRITE_FAILED",
    "phase": "INGEST",
    "channel": 1,
    "errorSource": "System",
    "category": "ingest",
    "nodeKinds": [
      "ingest"
    ],
    "description": "Delta write operation failed",
    "httpStatus": 200,
    "fltCodePath": "FileIngestionError.cs"
  },
  {
    "code": "MLV_INGEST_AUTH_FAILURE",
    "phase": "INGEST",
    "channel": 1,
    "errorSource": "User",
    "category": "ingest",
    "nodeKinds": [
      "ingest"
    ],
    "description": "Auth failure reading source files",
    "httpStatus": 200,
    "fltCodePath": "FileIngestionError.cs"
  },
  {
    "code": "MLV_INGEST_CONNECTION_TIMEOUT",
    "phase": "INGEST",
    "channel": 4,
    "errorSource": "System",
    "category": "ingest",
    "nodeKinds": [
      "ingest"
    ],
    "description": "Storage unreachable (network timeout)",
    "httpStatus": 0,
    "fltCodePath": "FileIngestionError.cs"
  },
  {
    "code": "MLV_INGEST_INTERNAL_ERROR",
    "phase": "INGEST",
    "channel": 1,
    "errorSource": "System",
    "category": "ingest",
    "nodeKinds": [
      "ingest"
    ],
    "description": "Unexpected internal ingestion error",
    "httpStatus": 200,
    "fltCodePath": "FileIngestionError.cs"
  },
  {
    "code": "MLV_INGEST_UNSUPPORTED_FORMAT",
    "phase": "INGEST",
    "channel": 1,
    "errorSource": "User",
    "category": "ingest",
    "nodeKinds": [
      "ingest"
    ],
    "description": "File format not recognized",
    "httpStatus": 200,
    "fltCodePath": "FileIngestionError.cs"
  },
  {
    "code": "MLV_INGEST_MISSING_REQUIRED_OPTION",
    "phase": "INGEST",
    "channel": 1,
    "errorSource": "User",
    "category": "ingest",
    "nodeKinds": [
      "ingest"
    ],
    "description": "Required DDL option missing",
    "httpStatus": 200,
    "fltCodePath": "FileIngestionError.cs"
  },
  {
    "code": "MLV_INGEST_EXTERNAL_MODIFICATION",
    "phase": "INGEST",
    "channel": 1,
    "errorSource": "System",
    "category": "ingest",
    "nodeKinds": [
      "ingest"
    ],
    "description": "Delta table modified outside pipeline",
    "httpStatus": 200,
    "fltCodePath": "FileIngestionError.cs"
  },
  {
    "code": "MLV_TERMINAL_STATE",
    "phase": "POST_EXECUTION",
    "channel": 3,
    "errorSource": "User",
    "category": "execution",
    "nodeKinds": [
      "sql",
      "pyspark",
      "ingest"
    ],
    "description": "Execution already finished, can't cancel",
    "httpStatus": 0,
    "fltCodePath": "LiveTableHandler.cs:168"
  },
  {
    "code": "MLV_REFRESH_PENDING",
    "phase": "POST_EXECUTION",
    "channel": 3,
    "errorSource": "User",
    "category": "execution",
    "nodeKinds": [
      "sql",
      "pyspark",
      "ingest"
    ],
    "description": "Iteration exists but not started",
    "httpStatus": 0,
    "fltCodePath": "LiveTableHandler.cs:161"
  },
  {
    "code": "MLV_OPERATION_INPROGRESS",
    "phase": "POST_EXECUTION",
    "channel": 3,
    "errorSource": "User",
    "category": "concurrency",
    "nodeKinds": [
      "sql",
      "pyspark",
      "ingest"
    ],
    "description": "Another operation in progress",
    "httpStatus": 0,
    "fltCodePath": "ErrorRegistry"
  },
  {
    "code": "MLV_RESOURCE_LOCKED",
    "phase": "POST_EXECUTION",
    "channel": 3,
    "errorSource": "User",
    "category": "concurrency",
    "nodeKinds": [
      "sql",
      "pyspark",
      "ingest"
    ],
    "description": "Entity locked by another operation",
    "httpStatus": 0,
    "fltCodePath": "ErrorRegistry"
  },
  {
    "code": "MLV_EXEC_DEFN_NOT_FOUND",
    "phase": "POST_EXECUTION",
    "channel": 3,
    "errorSource": "User",
    "category": "resource",
    "nodeKinds": [
      "sql",
      "pyspark",
      "ingest"
    ],
    "description": "Execution definition not found",
    "httpStatus": 0,
    "fltCodePath": "MLVExecutionDefinitionHandler.cs:130"
  },
  {
    "code": "MLV_EXEC_DEFN_EXISTS",
    "phase": "POST_EXECUTION",
    "channel": 3,
    "errorSource": "User",
    "category": "concurrency",
    "nodeKinds": [
      "sql",
      "pyspark",
      "ingest"
    ],
    "description": "Execution definition already exists",
    "httpStatus": 0,
    "fltCodePath": "MLVExecutionDefinitionHandler.cs:181"
  },
  {
    "code": "MLV_CANCEL_TIMEOUT",
    "phase": "NODE_EXECUTION",
    "channel": 1,
    "errorSource": "System",
    "category": "execution",
    "nodeKinds": [
      "sql",
      "pyspark",
      "ingest"
    ],
    "description": "Node cancellation timed out",
    "httpStatus": 200,
    "fltCodePath": "ErrorRegistry"
  },
  {
    "code": "DAG_EXECUTION_SKIPPED",
    "phase": "POST_EXECUTION",
    "channel": 3,
    "errorSource": "User",
    "category": "execution",
    "nodeKinds": [
      "sql",
      "pyspark",
      "ingest"
    ],
    "description": "DAG skipped \u2014 iteration already in progress",
    "httpStatus": 0,
    "fltCodePath": "DagExecutionHandlerV2.cs:904"
  },
  {
    "code": "MLV_SERVER_ERROR",
    "phase": "NODE_EXECUTION",
    "channel": 1,
    "errorSource": "System",
    "category": "system",
    "nodeKinds": [
      "sql",
      "pyspark",
      "ingest"
    ],
    "description": "Unexpected server error",
    "httpStatus": 200,
    "fltCodePath": "LiveTableController.cs:332"
  },
  {
    "code": "MLV_EXECUTION_DEFINITION_RETRIEVAL_FAILURE",
    "phase": "CATALOG_RESOLVE",
    "channel": 3,
    "errorSource": "System",
    "category": "resource",
    "nodeKinds": [
      "sql",
      "pyspark",
      "ingest"
    ],
    "description": "Failed to retrieve execution definition from OneLake",
    "httpStatus": 0,
    "fltCodePath": "ErrorRegistry"
  }
];
