/**
 * CodeGenerationEngine — Generates Fabric notebook cells from DAG state.
 *
 * Takes nodes, connections, theme, and schemas from WizardState.
 * Produces an ordered array of notebook cells (SQL + PySpark).
 * Uses topological sort (Kahn's algorithm) for deterministic ordering.
 *
 * @author Pixel — EDOG Studio hivemind
 */

/* ═══════════════════════════════════════════════════════════════════
   THEME COLUMN DEFINITIONS
   ═══════════════════════════════════════════════════════════════════ */

var THEME_COLUMNS = {
  ecommerce: [
    { name: 'order_id',         sqlType: 'INT' },
    { name: 'customer_name',    sqlType: 'VARCHAR(100)' },
    { name: 'product',          sqlType: 'VARCHAR(200)' },
    { name: 'quantity',         sqlType: 'INT' },
    { name: 'unit_price',       sqlType: 'DECIMAL(10,2)' },
    { name: 'order_date',       sqlType: 'DATE' },
    { name: 'status',           sqlType: 'VARCHAR(20)' },
    { name: 'shipping_address', sqlType: 'VARCHAR(500)' },
    { name: 'payment_method',   sqlType: 'VARCHAR(50)' },
    { name: 'total_amount',     sqlType: 'DECIMAL(12,2)' }
  ],
  sales: [
    { name: 'deal_id',       sqlType: 'INT' },
    { name: 'account_name',  sqlType: 'VARCHAR(200)' },
    { name: 'contact_name',  sqlType: 'VARCHAR(100)' },
    { name: 'stage',         sqlType: 'VARCHAR(50)' },
    { name: 'amount',        sqlType: 'DECIMAL(12,2)' },
    { name: 'close_date',    sqlType: 'DATE' },
    { name: 'probability',   sqlType: 'INT' },
    { name: 'owner',         sqlType: 'VARCHAR(100)' },
    { name: 'region',        sqlType: 'VARCHAR(50)' },
    { name: 'product_line',  sqlType: 'VARCHAR(100)' }
  ],
  iot: [
    { name: 'device_id',         sqlType: 'VARCHAR(50)' },
    { name: 'sensor_type',       sqlType: 'VARCHAR(50)' },
    { name: 'reading_value',     sqlType: 'DECIMAL(10,4)' },
    { name: 'unit',              sqlType: 'VARCHAR(20)' },
    { name: 'timestamp',         sqlType: 'DATETIME' },
    { name: 'location',          sqlType: 'VARCHAR(100)' },
    { name: 'battery_level',     sqlType: 'INT' },
    { name: 'signal_strength',   sqlType: 'INT' },
    { name: 'firmware_version',  sqlType: 'VARCHAR(20)' },
    { name: 'alert_flag',        sqlType: 'BIT' }
  ],
  hr: [
    { name: 'employee_id',  sqlType: 'INT' },
    { name: 'first_name',   sqlType: 'VARCHAR(50)' },
    { name: 'last_name',    sqlType: 'VARCHAR(50)' },
    { name: 'department',   sqlType: 'VARCHAR(100)' },
    { name: 'title',        sqlType: 'VARCHAR(100)' },
    { name: 'hire_date',    sqlType: 'DATE' },
    { name: 'salary',       sqlType: 'DECIMAL(10,2)' },
    { name: 'manager_id',   sqlType: 'INT' },
    { name: 'location',     sqlType: 'VARCHAR(100)' },
    { name: 'status',       sqlType: 'VARCHAR(20)' }
  ],
  finance: [
    { name: 'transaction_id',   sqlType: 'INT' },
    { name: 'account_number',   sqlType: 'VARCHAR(20)' },
    { name: 'transaction_type', sqlType: 'VARCHAR(20)' },
    { name: 'amount',           sqlType: 'DECIMAL(12,2)' },
    { name: 'currency',         sqlType: 'VARCHAR(3)' },
    { name: 'transaction_date', sqlType: 'DATE' },
    { name: 'counterparty',     sqlType: 'VARCHAR(200)' },
    { name: 'category',         sqlType: 'VARCHAR(50)' },
    { name: 'reference',        sqlType: 'VARCHAR(100)' },
    { name: 'balance',          sqlType: 'DECIMAL(14,2)' }
  ],
  healthcare: [
    { name: 'patient_id',      sqlType: 'INT' },
    { name: 'first_name',      sqlType: 'VARCHAR(50)' },
    { name: 'last_name',       sqlType: 'VARCHAR(50)' },
    { name: 'date_of_birth',   sqlType: 'DATE' },
    { name: 'diagnosis_code',  sqlType: 'VARCHAR(10)' },
    { name: 'provider',        sqlType: 'VARCHAR(200)' },
    { name: 'visit_date',      sqlType: 'DATE' },
    { name: 'treatment',       sqlType: 'VARCHAR(200)' },
    { name: 'medication',      sqlType: 'VARCHAR(100)' },
    { name: 'insurance_id',    sqlType: 'VARCHAR(50)' }
  ]
};

/* ═══════════════════════════════════════════════════════════════════
   SAMPLE DATA PER THEME (10 rows each)
   ═══════════════════════════════════════════════════════════════════ */

var THEME_SAMPLE_DATA = {
  ecommerce: [
    [1001, "'Alice Johnson'",   "'Wireless Mouse'",       2, 29.99,  "'2024-01-15'", "'Shipped'",    "'123 Oak St, Portland, OR 97201'",         "'Credit Card'",  59.98],
    [1002, "'Bob Martinez'",    "'USB-C Hub'",            1, 49.95,  "'2024-01-16'", "'Processing'", "'456 Elm Ave, Seattle, WA 98101'",         "'PayPal'",       49.95],
    [1003, "'Carol Chen'",      "'Mechanical Keyboard'",  1, 89.00,  "'2024-01-17'", "'Delivered'",  "'789 Pine Rd, San Francisco, CA 94102'",   "'Debit Card'",   89.00],
    [1004, "'David Kim'",       "'Monitor Stand'",        3, 34.50,  "'2024-01-18'", "'Shipped'",    "'321 Maple Dr, Austin, TX 78701'",         "'Credit Card'",  103.50],
    [1005, "'Eva Rossi'",       "'Webcam HD'",            1, 79.99,  "'2024-01-19'", "'Processing'", "'654 Birch Ln, Denver, CO 80201'",         "'Apple Pay'",    79.99],
    [1006, "'Frank O Brien'",   "'Desk Lamp LED'",        2, 42.00,  "'2024-01-20'", "'Delivered'",  "'987 Cedar Ct, Chicago, IL 60601'",        "'Credit Card'",  84.00],
    [1007, "'Grace Liu'",       "'Laptop Sleeve 15in'",   1, 25.99,  "'2024-01-21'", "'Shipped'",    "'147 Walnut St, Boston, MA 02101'",        "'PayPal'",       25.99],
    [1008, "'Hank Patel'",      "'Bluetooth Speaker'",    1, 64.50,  "'2024-01-22'", "'Cancelled'",  "'258 Spruce Way, Miami, FL 33101'",        "'Debit Card'",   64.50],
    [1009, "'Iris Tanaka'",     "'Mouse Pad XL'",         4, 15.99,  "'2024-01-23'", "'Delivered'",  "'369 Ash Blvd, Phoenix, AZ 85001'",        "'Credit Card'",  63.96],
    [1010, "'Jake Wilson'",     "'USB Cable Pack'",       2, 12.49,  "'2024-01-24'", "'Shipped'",    "'480 Redwood Pl, Nashville, TN 37201'",    "'Apple Pay'",    24.98]
  ],
  sales: [
    [5001, "'Acme Corp'",           "'Jane Smith'",      "'Negotiation'",  75000.00,  "'2024-03-15'", 60,  "'Tom Harris'",    "'West'",       "'Enterprise'"],
    [5002, "'TechFlow Inc'",        "'Mike Chen'",       "'Proposal'",     42000.00,  "'2024-03-20'", 40,  "'Sara Lopez'",    "'East'",       "'SaaS'"],
    [5003, "'GlobalMedia LLC'",     "'Anne Brown'",      "'Closed Won'",   128000.00, "'2024-02-28'", 100, "'Tom Harris'",    "'West'",       "'Enterprise'"],
    [5004, "'Vertex Solutions'",    "'Raj Patel'",       "'Discovery'",    35000.00,  "'2024-04-10'", 20,  "'Dana Kim'",      "'Central'",    "'SMB'"],
    [5005, "'NovaBuild'",           "'Lisa Chung'",      "'Negotiation'",  91000.00,  "'2024-03-25'", 70,  "'Sara Lopez'",    "'East'",       "'Enterprise'"],
    [5006, "'Pinnacle Group'",      "'Derek Fox'",       "'Closed Lost'",  58000.00,  "'2024-02-15'", 0,   "'Dana Kim'",      "'Central'",    "'SaaS'"],
    [5007, "'Streamline Co'",       "'Mia Torres'",      "'Proposal'",     67000.00,  "'2024-04-01'", 50,  "'Tom Harris'",    "'West'",       "'SMB'"],
    [5008, "'Bright Dynamics'",     "'Sam Wright'",      "'Discovery'",    23000.00,  "'2024-04-18'", 15,  "'Sara Lopez'",    "'East'",       "'SaaS'"],
    [5009, "'Catalyst Partners'",   "'Nora Ali'",        "'Closed Won'",   105000.00, "'2024-01-30'", 100, "'Dana Kim'",      "'Central'",    "'Enterprise'"],
    [5010, "'Zenith Retail'",       "'Paul Grant'",      "'Negotiation'",  48000.00,  "'2024-03-30'", 55,  "'Tom Harris'",    "'West'",       "'SMB'"]
  ],
  iot: [
    ["'DEV-TH-001'", "'temperature'",  22.4500, "'celsius'",     "'2024-01-15 08:00:00'", "'Building A Floor 3'",   95, -42, "'2.1.0'", 0],
    ["'DEV-TH-002'", "'temperature'",  23.1200, "'celsius'",     "'2024-01-15 08:01:00'", "'Building A Floor 1'",   88, -55, "'2.1.0'", 0],
    ["'DEV-HM-003'", "'humidity'",     45.8000, "'percent'",     "'2024-01-15 08:02:00'", "'Building B Floor 2'",   72, -61, "'2.0.8'", 0],
    ["'DEV-PR-004'", "'pressure'",     1013.25, "'hPa'",         "'2024-01-15 08:03:00'", "'Rooftop Sensor Bay'",   100,-38, "'2.1.0'", 0],
    ["'DEV-TH-005'", "'temperature'",  19.8700, "'celsius'",     "'2024-01-15 08:04:00'", "'Warehouse Zone C'",     63, -70, "'1.9.5'", 1],
    ["'DEV-CO-006'", "'co2'",          412.00,  "'ppm'",         "'2024-01-15 08:05:00'", "'Building A Floor 2'",   91, -45, "'2.1.0'", 0],
    ["'DEV-HM-007'", "'humidity'",     62.3400, "'percent'",     "'2024-01-15 08:06:00'", "'Server Room 1'",        85, -50, "'2.0.8'", 1],
    ["'DEV-TH-008'", "'temperature'",  26.9100, "'celsius'",     "'2024-01-15 08:07:00'", "'Server Room 1'",        85, -48, "'2.1.0'", 1],
    ["'DEV-MO-009'", "'motion'",       1.0000,  "'binary'",      "'2024-01-15 08:08:00'", "'Entrance Lobby'",       97, -35, "'2.1.0'", 0],
    ["'DEV-LX-010'", "'light'",        340.50,  "'lux'",         "'2024-01-15 08:09:00'", "'Building B Floor 1'",   79, -58, "'2.0.8'", 0]
  ],
  hr: [
    [2001, "'Emily'",    "'Carter'",    "'Engineering'",    "'Software Engineer'",     "'2021-03-15'", 95000.00,  2000, "'Seattle'",     "'Active'"],
    [2002, "'Marcus'",   "'Reed'",      "'Engineering'",    "'Senior Engineer'",       "'2019-07-01'", 125000.00, 2000, "'Seattle'",     "'Active'"],
    [2003, "'Priya'",    "'Sharma'",    "'Product'",        "'Product Manager'",       "'2020-11-10'", 115000.00, 2010, "'San Francisco'","'Active'"],
    [2004, "'James'",    "'O Neill'",   "'Marketing'",      "'Marketing Analyst'",     "'2022-01-20'", 72000.00,  2020, "'New York'",    "'Active'"],
    [2005, "'Sofia'",    "'Gonzalez'",  "'Engineering'",    "'QA Engineer'",           "'2021-09-05'", 88000.00,  2002, "'Seattle'",     "'Active'"],
    [2006, "'Liam'",     "'Zhang'",     "'Finance'",        "'Financial Analyst'",     "'2023-02-14'", 82000.00,  2030, "'Chicago'",     "'Active'"],
    [2007, "'Aisha'",    "'Mohammed'",  "'Engineering'",    "'DevOps Engineer'",       "'2020-06-22'", 110000.00, 2000, "'Seattle'",     "'Active'"],
    [2008, "'Daniel'",   "'Fischer'",   "'HR'",             "'HR Business Partner'",   "'2018-04-01'", 98000.00,  2040, "'New York'",    "'Active'"],
    [2009, "'Yuki'",     "'Sato'",      "'Engineering'",    "'Staff Engineer'",        "'2017-08-15'", 155000.00, null, "'San Francisco'","'Active'"],
    [2010, "'Rachel'",   "'Murphy'",    "'Product'",        "'Senior PM'",             "'2019-01-10'", 135000.00, 2010, "'San Francisco'","'On Leave'"]
  ],
  finance: [
    [9001, "'ACC-100234'", "'Credit'",   5000.00,   "'USD'", "'2024-01-15'", "'Payroll Dept'",          "'Payroll'",       "'REF-2024-0001'", 152340.00],
    [9002, "'ACC-100234'", "'Debit'",    1250.75,   "'USD'", "'2024-01-16'", "'CloudHost Inc'",         "'Infrastructure'","'REF-2024-0002'", 151089.25],
    [9003, "'ACC-200567'", "'Credit'",   28000.00,  "'USD'", "'2024-01-16'", "'Apex Client Group'",     "'Revenue'",       "'REF-2024-0003'", 284500.00],
    [9004, "'ACC-100234'", "'Debit'",    430.00,    "'USD'", "'2024-01-17'", "'Office Supplies Co'",    "'Operations'",    "'REF-2024-0004'", 150659.25],
    [9005, "'ACC-300891'", "'Debit'",    15000.00,  "'EUR'", "'2024-01-17'", "'Berlin Partners GmbH'",  "'Consulting'",    "'REF-2024-0005'", 67200.00],
    [9006, "'ACC-100234'", "'Credit'",   12000.00,  "'USD'", "'2024-01-18'", "'RetailMax Corp'",        "'Revenue'",       "'REF-2024-0006'", 162659.25],
    [9007, "'ACC-200567'", "'Debit'",    3200.00,   "'USD'", "'2024-01-18'", "'Marketing Agency Ltd'",  "'Marketing'",     "'REF-2024-0007'", 281300.00],
    [9008, "'ACC-300891'", "'Credit'",   8500.00,   "'EUR'", "'2024-01-19'", "'Munich Systems AG'",     "'Revenue'",       "'REF-2024-0008'", 75700.00],
    [9009, "'ACC-100234'", "'Debit'",    875.50,    "'USD'", "'2024-01-19'", "'Travel Express'",        "'Travel'",        "'REF-2024-0009'", 161783.75],
    [9010, "'ACC-200567'", "'Debit'",    6400.00,   "'USD'", "'2024-01-20'", "'TechVendor Solutions'",  "'Software'",      "'REF-2024-0010'", 274900.00]
  ],
  healthcare: [
    [3001, "'Sarah'",    "'Thompson'",  "'1985-04-12'", "'J06.9'",  "'Metro General Hospital'",    "'2024-01-10'", "'Observation and assessment'",   "'Acetaminophen'",   "'INS-5001'"],
    [3002, "'William'",  "'Davis'",     "'1972-09-23'", "'I10'",    "'Lakeside Medical Center'",   "'2024-01-11'", "'Blood pressure monitoring'",    "'Lisinopril'",      "'INS-5002'"],
    [3003, "'Maria'",    "'Santos'",    "'1990-01-05'", "'M54.5'",  "'City Health Clinic'",        "'2024-01-12'", "'Physical therapy referral'",    "'Ibuprofen'",       "'INS-5003'"],
    [3004, "'Robert'",   "'Kim'",       "'1968-11-30'", "'E11.9'",  "'Metro General Hospital'",    "'2024-01-13'", "'Glucose management plan'",      "'Metformin'",       "'INS-5004'"],
    [3005, "'Jennifer'", "'Walsh'",     "'1995-06-18'", "'J45.909'","'Lakeside Medical Center'",   "'2024-01-14'", "'Inhaler prescription renewal'", "'Albuterol'",       "'INS-5005'"],
    [3006, "'Ahmed'",    "'Hassan'",    "'1980-03-07'", "'K21.0'",  "'City Health Clinic'",        "'2024-01-15'", "'Dietary counseling'",           "'Omeprazole'",      "'INS-5001'"],
    [3007, "'Linda'",    "'Nguyen'",    "'1958-12-25'", "'M81.0'",  "'Metro General Hospital'",    "'2024-01-16'", "'Bone density scan'",            "'Alendronate'",     "'INS-5006'"],
    [3008, "'Thomas'",   "'Brown'",     "'1987-08-14'", "'F41.1'",  "'Lakeside Medical Center'",   "'2024-01-17'", "'Cognitive behavioral therapy'", "'Sertraline'",      "'INS-5002'"],
    [3009, "'Fatima'",   "'Ali'",       "'1975-02-20'", "'E78.5'",  "'City Health Clinic'",        "'2024-01-18'", "'Lipid panel review'",           "'Atorvastatin'",    "'INS-5007'"],
    [3010, "'George'",   "'Miller'",    "'1962-07-09'", "'I25.10'", "'Metro General Hospital'",    "'2024-01-19'", "'Cardiac stress test'",          "'Aspirin'",         "'INS-5004'"]
  ]
};

/* ═══════════════════════════════════════════════════════════════════
   CODE GENERATION ENGINE
   ═══════════════════════════════════════════════════════════════════ */

class CodeGenerationEngine {

  constructor() {}

  /* ─── Public API ─── */

  /**
   * Generate notebook cells from DAG state.
   * @param {Array} nodes       DagNodeData[]
   * @param {Array} connections ConnectionData[]
   * @param {string} theme      Theme ID
   * @param {Object} schemas    Schema flags { dbo, bronze, silver, gold }
   * @returns {Array} Cell objects in topological order
   */
  generateCells(nodes, connections, theme, schemas) {
    var sorted = this._topologicalSort(nodes, connections);
    if (!sorted) {
      console.error('[CodeGenerationEngine] Cycle detected in DAG — cannot generate cells');
      return [];
    }

    // Build lookup maps
    var nodeMap = {};
    for (var n = 0; n < nodes.length; n++) {
      nodeMap[nodes[n].id] = nodes[n];
    }

    // Build parent lookup: targetNodeId -> [sourceNode, ...]
    var parentMap = {};
    for (var c = 0; c < connections.length; c++) {
      var conn = connections[c];
      if (!parentMap[conn.targetNodeId]) {
        parentMap[conn.targetNodeId] = [];
      }
      parentMap[conn.targetNodeId].push(nodeMap[conn.sourceNodeId]);
    }

    var cells = [];
    for (var i = 0; i < sorted.length; i++) {
      var node = nodeMap[sorted[i]];
      if (!node) continue;

      var cell = null;
      if (node.type === 'sql-table') {
        cell = this._generateTableCell(node, theme);
      } else if (node.type === 'sql-mlv') {
        cell = this._generateSqlMlvCell(node, parentMap[node.id] || []);
      } else if (node.type === 'pyspark-mlv') {
        cell = this._generatePysparkMlvCell(node, parentMap[node.id] || []);
      }

      if (cell) {
        cells.push(cell);
      }
    }

    return cells;
  }

  /**
   * Wrap cells into a Fabric API notebook payload.
   * @param {Array} cells  Cell objects from generateCells()
   * @returns {Object} Fabric notebook format
   */
  generateNotebookPayload(cells) {
    return {
      definition: {
        format: 'ipynb',
        parts: [{
          path: 'notebook-content.py',
          payload: JSON.stringify({
            cells: cells.map(function(c) {
              return {
                cell_type: 'code',
                source: [c.content],
                metadata: {
                  'microsoft.fabric': { language: c.language },
                  'node_id': c.nodeId,
                  'node_name': c.nodeName
                },
                outputs: [],
                execution_count: null
              };
            }),
            metadata: {
              kernel_info: { name: 'synapse_pyspark' },
              language_info: { name: 'python' }
            },
            nbformat: 4,
            nbformat_minor: 5
          }),
          payloadType: 'InlineBase64'
        }]
      }
    };
  }

  /* ─── Topological Sort (Kahn's Algorithm) ─── */

  /**
   * @param {Array} nodes       DagNodeData[]
   * @param {Array} connections ConnectionData[]
   * @returns {Array|null} Ordered node IDs, or null if cycle detected
   */
  _topologicalSort(nodes, connections) {
    // Build adjacency list and in-degree map
    var adj = {};
    var inDegree = {};
    var nodeIndex = {};

    for (var n = 0; n < nodes.length; n++) {
      var id = nodes[n].id;
      adj[id] = [];
      inDegree[id] = 0;
      nodeIndex[id] = nodes[n];
    }

    for (var c = 0; c < connections.length; c++) {
      var src = connections[c].sourceNodeId;
      var tgt = connections[c].targetNodeId;
      adj[src].push(tgt);
      inDegree[tgt] = (inDegree[tgt] || 0) + 1;
    }

    // Initialize queue with nodes having in-degree 0
    var queue = [];
    for (var nid in inDegree) {
      if (inDegree[nid] === 0) {
        queue.push(nid);
      }
    }

    // Sort queue for determinism: by createdAt, then by id
    queue.sort(function(a, b) {
      var ca = nodeIndex[a].createdAt || 0;
      var cb = nodeIndex[b].createdAt || 0;
      if (ca !== cb) return ca - cb;
      return a < b ? -1 : (a > b ? 1 : 0);
    });

    var result = [];

    while (queue.length > 0) {
      var current = queue.shift();
      result.push(current);

      var neighbors = adj[current];
      // Collect newly-freed neighbors, then sort for determinism
      var freed = [];
      for (var j = 0; j < neighbors.length; j++) {
        inDegree[neighbors[j]]--;
        if (inDegree[neighbors[j]] === 0) {
          freed.push(neighbors[j]);
        }
      }

      if (freed.length > 0) {
        freed.sort(function(a, b) {
          var ca = nodeIndex[a].createdAt || 0;
          var cb = nodeIndex[b].createdAt || 0;
          if (ca !== cb) return ca - cb;
          return a < b ? -1 : (a > b ? 1 : 0);
        });
        for (var f = 0; f < freed.length; f++) {
          queue.push(freed[f]);
        }
      }
    }

    // Cycle detection
    if (result.length !== nodes.length) {
      return null;
    }

    return result;
  }

  /* ─── Cell Generators ─── */

  /**
   * Generate a SQL CREATE TABLE + INSERT cell.
   * @param {Object} node   DagNodeData
   * @param {string} theme  Theme ID
   * @returns {Object} Cell object
   */
  _generateTableCell(node, theme) {
    var columns = this._getThemeColumns(theme);
    var rows = this._generateSampleRows(theme, 10);
    var schema = node.schema || 'dbo';

    var lines = [];
    lines.push('-- Create table: [' + schema + '].[' + node.name + ']');
    lines.push('CREATE TABLE [' + schema + '].[' + node.name + '] (');

    for (var i = 0; i < columns.length; i++) {
      var sep = (i < columns.length - 1) ? ',' : '';
      lines.push('  ' + columns[i].name + ' ' + columns[i].sqlType + sep);
    }
    lines.push(');');
    lines.push('');
    lines.push('-- Insert sample data');
    lines.push('INSERT INTO [' + schema + '].[' + node.name + '] VALUES');

    for (var r = 0; r < rows.length; r++) {
      var rowStr = '  (' + rows[r].join(', ') + ')';
      rowStr += (r < rows.length - 1) ? ',' : ';';
      lines.push(rowStr);
    }

    return {
      type: 'sql-table',
      language: 'sql',
      nodeId: node.id,
      nodeName: node.name,
      content: lines.join('\n')
    };
  }

  /**
   * Generate a SQL MLV (materialized lakehouse view) cell.
   * @param {Object} node        DagNodeData
   * @param {Array}  parentNodes DagNodeData[] of parent/source nodes
   * @returns {Object} Cell object
   */
  _generateSqlMlvCell(node, parentNodes) {
    var schema = node.schema || 'dbo';
    var lines = [];

    var parentNames = [];
    for (var p = 0; p < parentNodes.length; p++) {
      parentNames.push(parentNodes[p].name);
    }

    lines.push('-- Create materialized lakehouse view: [' + schema + '].[' + node.name + ']');
    lines.push('-- Sources: ' + (parentNames.length > 0 ? parentNames.join(', ') : 'none'));
    lines.push('CREATE OR ALTER VIEW [' + schema + '].[' + node.name + '] AS');
    lines.push('SELECT');

    if (parentNodes.length === 0) {
      lines.push('  1 AS placeholder');
      lines.push('FROM (SELECT 1) AS empty;');
    } else if (parentNodes.length === 1) {
      var p1 = parentNodes[0];
      var p1Schema = p1.schema || 'dbo';
      lines.push('  t1.*');
      lines.push('FROM [' + p1Schema + '].[' + p1.name + '] t1;');
    } else {
      // Multiple parents — join them
      var firstParent = parentNodes[0];
      var firstSchema = firstParent.schema || 'dbo';

      lines.push('  t1.*,');
      for (var m = 1; m < parentNodes.length; m++) {
        var suffix = (m < parentNodes.length - 1) ? ',' : '';
        lines.push('  t' + (m + 1) + '.*' + suffix);
      }
      lines.push('FROM [' + firstSchema + '].[' + firstParent.name + '] t1');

      for (var k = 1; k < parentNodes.length; k++) {
        var joinParent = parentNodes[k];
        var joinSchema = joinParent.schema || 'dbo';
        var alias = 't' + (k + 1);
        lines.push('INNER JOIN [' + joinSchema + '].[' + joinParent.name + '] ' + alias);
        lines.push('  ON t1.id = ' + alias + '.id;');
      }
    }

    return {
      type: 'sql-mlv',
      language: 'sql',
      nodeId: node.id,
      nodeName: node.name,
      content: lines.join('\n')
    };
  }

  /**
   * Generate a PySpark MLV cell.
   * @param {Object} node        DagNodeData
   * @param {Array}  parentNodes DagNodeData[] of parent/source nodes
   * @returns {Object} Cell object
   */
  _generatePysparkMlvCell(node, parentNodes) {
    var schema = node.schema || 'dbo';
    var lines = [];

    var parentNames = [];
    for (var p = 0; p < parentNodes.length; p++) {
      parentNames.push(parentNodes[p].name);
    }

    lines.push('# PySpark materialized view: ' + schema + '.' + node.name);
    lines.push('# Sources: ' + (parentNames.length > 0 ? parentNames.join(', ') : 'none'));
    lines.push('from pyspark.sql import SparkSession');
    lines.push('');
    lines.push('spark = SparkSession.builder.getOrCreate()');
    lines.push('');

    if (parentNodes.length === 0) {
      lines.push('df_result = spark.sql("SELECT 1 AS placeholder")');
    } else {
      // Read each parent
      for (var i = 0; i < parentNodes.length; i++) {
        var pNode = parentNodes[i];
        var pSchema = pNode.schema || 'dbo';
        var dfName = 'df_' + pNode.name.replace(/[^a-zA-Z0-9_]/g, '_');
        lines.push(dfName + ' = spark.sql("SELECT * FROM ' + pSchema + '.' + pNode.name + '")');
      }
      lines.push('');

      if (parentNodes.length === 1) {
        var singleDf = 'df_' + parentNodes[0].name.replace(/[^a-zA-Z0-9_]/g, '_');
        lines.push('df_result = ' + singleDf);
      } else {
        // Chain joins
        var baseDf = 'df_' + parentNodes[0].name.replace(/[^a-zA-Z0-9_]/g, '_');
        var joinExpr = 'df_result = ' + baseDf;
        for (var j = 1; j < parentNodes.length; j++) {
          var nextDf = 'df_' + parentNodes[j].name.replace(/[^a-zA-Z0-9_]/g, '_');
          joinExpr += '.join(' + nextDf + ', ' + baseDf + '["id"] == ' + nextDf + '["id"])';
        }
        lines.push(joinExpr);
      }
    }

    lines.push('');
    lines.push('df_result.write.format("delta").mode("overwrite").saveAsTable("' + schema + '.' + node.name + '")');

    return {
      type: 'pyspark-mlv',
      language: 'python',
      nodeId: node.id,
      nodeName: node.name,
      content: lines.join('\n')
    };
  }

  /* ─── Theme Helpers ─── */

  /**
   * Return column definitions for a theme.
   * @param {string} theme  Theme ID
   * @returns {Array} Column objects { name, sqlType }
   */
  _getThemeColumns(theme) {
    return THEME_COLUMNS[theme] || THEME_COLUMNS['ecommerce'];
  }

  /**
   * Return sample data rows for a theme.
   * @param {string} theme     Theme ID
   * @param {number} rowCount  Number of rows to return
   * @returns {Array} Array of row arrays
   */
  _generateSampleRows(theme, rowCount) {
    var data = THEME_SAMPLE_DATA[theme] || THEME_SAMPLE_DATA['ecommerce'];
    var count = Math.min(rowCount, data.length);
    var rows = [];
    for (var i = 0; i < count; i++) {
      rows.push(data[i]);
    }
    return rows;
  }
}

window.CodeGenerationEngine = CodeGenerationEngine;
