// <copyright file="EdogSessionController.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.Controllers
{
    using System;
    using Microsoft.AspNetCore.Cors;
    using Microsoft.AspNetCore.Mvc;
    using Microsoft.Fabric.Platform.AccessProtection.WebApi.Attributes;
    using Microsoft.LiveTable.Service.Common.Annotations;
    using Microsoft.LiveTable.Service.DevMode;
    using Microsoft.MWC.Workload.Client.Library.Controllers;
    using Microsoft.MWC.Workload.Client.Library.Http;
    using Microsoft.ServicePlatform.WebApi.Authentication;

    /// <summary>
    /// DevMode-only controller exposing EDOG session registry over the
    /// capacity host HTTP pipeline for cross-machine session probing.
    /// </summary>
    [AuthenticationEngine]
    [EnableCors(PolicyName = CorsPolicies.AllowAllCorsPolicyName)]
    [InitializeCapacityContext]
    [Route("v1/workspaces/{workspaceId}/lakehouses/{artifactId}/liveTable/edogSessions")]
    [ApiExplorerSettings(IgnoreApi = true)]
    public sealed class EdogSessionController : BaseApiController
    {
        /// <summary>
        /// Returns all active EDOG sessions on this capacity.
        /// Called by other engineers' EDOG instances before deploy
        /// to detect active sessions that would be disconnected.
        /// </summary>
        /// <returns>JSON with capacity info and session list.</returns>
        [HttpGet]
        [Route("list")]
        [SkipNetworkAccessFilteringForOutOfScopeApi]
        public IActionResult GetSessions()
        {
            try
            {
                var snapshot = EdogSessionRegistry.GetSnapshot();
                var json = System.Text.Json.JsonSerializer.Serialize(snapshot,
                    new System.Text.Json.JsonSerializerOptions
                    {
                        PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase,
                        WriteIndented = false,
                    });
                return new ContentResult
                {
                    Content = json,
                    ContentType = "application/json",
                    StatusCode = 200,
                };
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[EDOG] EdogSessionController.GetSessions error: {ex}");
                return new ContentResult
                {
                    Content = "{\"sessions\":[],\"error\":\"" + ex.Message.Replace("\"", "'") + "\"}",
                    ContentType = "application/json",
                    StatusCode = 200,
                };
            }
        }
    }
}
