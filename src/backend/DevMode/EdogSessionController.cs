// <copyright file="EdogSessionController.cs" company="Microsoft">
// Copyright (c) Microsoft Corporation. All rights reserved.
// </copyright>

#nullable disable
#pragma warning disable // DevMode-only file — suppress all warnings

namespace Microsoft.LiveTable.Service.DevMode
{
    using System;
    using Microsoft.AspNetCore.Cors;
    using Microsoft.AspNetCore.Mvc;
    using Microsoft.Fabric.Platform.AccessProtection.WebApi.Attributes;
    using Microsoft.MWC.Workload.Client.Library.Controllers;
    using Microsoft.MWC.Workload.Client.Library.Http;
    using Microsoft.ServicePlatform.WebApi.Authentication;

    /// <summary>
    /// DevMode-only controller exposing EDOG session registry over the
    /// capacity host HTTP pipeline. Accessible from any machine that can
    /// reach the capacity host — enables cross-machine session probing
    /// for the Session Guard feature (deploy collision detection).
    ///
    /// Route: publicUnprotected/edog/sessions
    /// Auth: none (same as ping — DevMode is a dev-time feature)
    /// </summary>
    [AuthenticationEngine]
    [EnableCors(PolicyName = CorsPolicies.AllowAllCorsPolicyName)]
    [Route("publicUnprotected/edog")]
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
        [Route("sessions")]
        [SkipNetworkAccessFilteringForOutOfScopeApi]
        public IActionResult GetSessions()
        {
            try
            {
                var snapshot = EdogSessionRegistry.GetSnapshot();
                return this.Ok(snapshot);
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[EDOG] EdogSessionController.GetSessions error: {ex.Message}");
                return this.Ok(new
                {
                    capacityId = (string)null,
                    sessions = Array.Empty<object>(),
                    error = "internal_error",
                });
            }
        }
    }
}
