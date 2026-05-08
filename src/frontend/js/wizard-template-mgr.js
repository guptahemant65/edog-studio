/**
 * TemplateManager (C12) — Save/load/delete wizard configurations.
 *
 * Manages template CRUD via fetch() calls to dev-server /api/templates routes.
 * Users can save their current wizard state as a reusable template,
 * then load it later to pre-populate a new wizard session.
 *
 * CSS prefix: .iw-
 * @author Pixel — EDOG Studio hivemind
 */

/* global IW_EVENTS */

/* ═══════════════════════════════════════════════════════════════════
   TEMPLATE MANAGER
   ═══════════════════════════════════════════════════════════════════ */

var TemplateManager = (function () {
  "use strict";

  function TemplateManager(options) {
    var opts = options || {};
    this._eventBus = opts.eventBus || null;
    this._baseUrl = opts.baseUrl || "";
    this._templates = [];
    this._loading = false;
  }

  /**
   * Fetch all template summaries from the server.
   * @returns {Promise} resolves with {templates: Array}
   */
  TemplateManager.prototype.listTemplates = function () {
    var self = this;
    self._loading = true;
    return fetch(self._baseUrl + "/api/templates", { method: "GET" })
      .then(function (response) {
        if (!response.ok) throw new Error("Failed to fetch templates");
        return response.json();
      })
      .then(function (data) {
        self._templates = data.templates || [];
        self._loading = false;
        return data;
      })
      .catch(function (err) {
        self._loading = false;
        throw err;
      });
  };

  /**
   * Fetch a single template with full state.
   * @param {string} templateId
   * @returns {Promise} resolves with the full template object
   */
  TemplateManager.prototype.getTemplate = function (templateId) {
    return fetch(this._baseUrl + "/api/templates/" + templateId, {
      method: "GET",
    }).then(function (response) {
      if (!response.ok) throw new Error("Template not found");
      return response.json();
    });
  };

  /**
   * Save the current wizard state as a new template.
   * @param {string} name — template name
   * @param {string} description — optional description
   * @param {object} state — wizard state (theme, schemas, nodes, connections, viewport)
   * @returns {Promise} resolves with {id, name, savedAt, success}
   */
  TemplateManager.prototype.saveTemplate = function (name, description, state) {
    var payload = {
      name: name,
      description: description || "",
      state: {
        theme: state.theme,
        schemas: state.schemas,
        nodes: state.nodes,
        connections: state.connections,
        viewport: state.viewport,
      },
    };
    return fetch(this._baseUrl + "/api/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(function (response) {
      if (!response.ok) throw new Error("Failed to save template");
      return response.json();
    });
  };

  /**
   * Delete a template by ID.
   * @param {string} templateId
   * @returns {Promise} resolves with {success, deleted}
   */
  TemplateManager.prototype.deleteTemplate = function (templateId) {
    return fetch(this._baseUrl + "/api/templates/" + templateId, {
      method: "DELETE",
    }).then(function (response) {
      if (!response.ok) throw new Error("Failed to delete template");
      return response.json();
    });
  };

  /**
   * Apply a template's state to the wizard.
   * Returns the template's state object for the caller to merge into WizardState.
   * @param {string} templateId
   * @returns {Promise} resolves with the template's state object
   */
  TemplateManager.prototype.applyTemplate = function (templateId) {
    return this.getTemplate(templateId).then(function (template) {
      return template.state || {};
    });
  };

  /** Synchronous accessor for cached template list. */
  TemplateManager.prototype.getTemplates = function () {
    return this._templates;
  };

  /** Whether a list request is in flight. */
  TemplateManager.prototype.isLoading = function () {
    return this._loading;
  };

  /** Tear down — release references. */
  TemplateManager.prototype.destroy = function () {
    this._templates = [];
    this._eventBus = null;
  };

  return TemplateManager;
})();

window.TemplateManager = TemplateManager;
