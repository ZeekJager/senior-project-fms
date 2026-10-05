const crypto = require('crypto');

function requestContext(req, res, next) {
  // Give every request a unique correlation ID for the audit log
  req.correlationId = crypto.randomUUID();
  
  // Later in FMS-05 (Auth), req.user will be populated by JWT.
  // We'll mock it for now so the audit log has an actor.
  if (!req.user) {
    req.user = { id: null }; 
  }
  
  next();
}

module.exports = requestContext;
