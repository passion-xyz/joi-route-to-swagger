const _ = require("lodash");
const joi2json = require("joi-to-json");

function _messageDescriptionWithExample(schema) {
  if (!schema.description) {
    schema.description = "";
  }
  if (schema && schema.example) {
    schema.description += ` (Example: ${schema.example})`;
  }
}

function _convertJsonSchemaToParamObj(jsonSchema, fieldName) {
  const schema = jsonSchema.properties[fieldName];

  const paramObj = _.pick(schema, ["description", "examples"]);
  paramObj.name = fieldName;

  if (jsonSchema.required && jsonSchema.required.includes(fieldName)) {
    paramObj.required = true;
  }
  if (!_.isEmpty(paramObj.examples)) {
    paramObj.example = paramObj.examples[0];
    delete paramObj.examples;
  }
  paramObj.schema = _.omit(schema, ["description", "example"]);
  paramObj.example = schema.example;

  _messageDescriptionWithExample(paramObj);
  return paramObj;
}

function addRouteParameters(sharedSchemas, route, validators, position) {
  const validator = validators ? validators[position] : null;
  if (!validator) {
    return;
  }

  const joiJsonSchema = joi2json(
    validators[position],
    "open-api",
    sharedSchemas,
  );
  delete joiJsonSchema.schemas;

  _.forEach(joiJsonSchema.properties, (schema, field) => {
    const paramObj = _convertJsonSchemaToParamObj(joiJsonSchema, field);

    if (position === "queryStringParameters") {
      paramObj.in = "query";
    } else if (position === "pathParameters") {
      paramObj.in = "path";
    } else {
      paramObj.in = position;
    }
    route.parameters.push(paramObj);
  });
}

function containsBinaryField(schema, sharedSchemas) {
  let anyBinaryField = _.some(schema.properties, (fieldDefn) => {
    if (fieldDefn.type === "array") {
      return fieldDefn.items.format === "binary";
    }
    return fieldDefn.format === "binary";
  });

  if (!anyBinaryField && schema.$ref) {
    const sharedSchemaName = schema.$ref.replace("#/components/schemas/", "");
    anyBinaryField = containsBinaryField(sharedSchemas[sharedSchemaName]);
  }

  return anyBinaryField;
}

function addRequestBodyParams(sharedSchemas, swaggerReq, validators) {
  if (validators && validators.body) {
    const schema = joi2json(validators.body, "open-api", sharedSchemas);
    delete schema.schemas;

    let contentType = "application/json";

    if (containsBinaryField(schema, sharedSchemas)) {
      contentType = "multipart/form-data";
    }

    swaggerReq.requestBody = {
      content: {
        [contentType]: {
          schema,
        },
      },
    };
  }
}

function addRequestPathParams(sharedSchemas, route, pathParams, validators) {
  let pathParamSchema;
  if (validators && validators.path) {
    pathParamSchema = joi2json(validators.path, "open-api", sharedSchemas);
    delete pathParamSchema.schemas;
  }

  _.forEach(pathParams, (param) => {
    let schema = {
      name: param,
      required: true,
      schema: {
        type: "string",
      },
    };

    if (pathParamSchema) {
      schema = _convertJsonSchemaToParamObj(pathParamSchema, param);
    }

    schema.in = "path";
    if (!schema.description) {
      schema.description = "";
    }
    route.parameters.push(schema);
  });
}

function addResponseExample(sharedSchemas, routeDef, route) {
  _.forEach(routeDef.responseExamples, (example) => {
    if (!example.schema) {
      return;
    }

    const schema = joi2json(example.schema, "open-api", sharedSchemas);
    delete schema.schemas;
    const mediaType = example.mediaType || "application/json";

    route.responses[example.code] = {
      description: example.description || "Normal Response",
      content: {
        [mediaType]: {
          schema,
        },
      },
    };
  });
}

function buildSwaggerRequest(docEntity, routeEntity, tag, basePath, routeDef) {
  const routePaths = docEntity.paths;
  const pathParams = [];
  const pathComponents = (basePath + routeDef.path)
    .split("/")
    .map((component) => {
      if (component.indexOf(":") === 0) {
        pathParams.push(component.substring(1));
        return `{${component.substring(1)}}`;
      }

      return component;
    });

  const pathString = pathComponents.join("/");
  const routePath = routePaths[pathString] || {};
  routePaths[pathString] = routePath;

  const swaggerReq = _.cloneDeep(routeEntity);
  swaggerReq.tags.push(tag);
  swaggerReq.summary = routeDef.summary;
  swaggerReq.description = routeDef.description;
  swaggerReq.security = routeDef.security;
  if (routeDef.deprecated) {
    swaggerReq.deprecated = routeDef.deprecated;
  }

  routePath[routeDef.method] = swaggerReq;

  const validators = routeDef.validators;
  const sharedSchemas = docEntity.components.schemas;

  addRequestPathParams(sharedSchemas, swaggerReq, pathParams, validators);
  addRouteParameters(sharedSchemas, swaggerReq, validators, "query");
  addRouteParameters(
    sharedSchemas,
    swaggerReq,
    validators,
    "queryStringParameters",
  );
  addRouteParameters(sharedSchemas, swaggerReq, validators, "header");
  addRouteParameters(sharedSchemas, swaggerReq, validators, "pathParameters");
  addRequestBodyParams(sharedSchemas, swaggerReq, validators);

  addResponseExample(sharedSchemas, routeDef, swaggerReq);
}

function buildModuleRoutes(docEntity, routeEntity, moduleRoutes) {
  const moduleId = moduleRoutes.basePath.substring(1).replace(/\//g, "-");
  const tag = moduleRoutes.name || moduleId;

  const tagObject = {
    name: tag,
    description: moduleRoutes.description || moduleId,
  };
  const found = _.find(docEntity.tags, { name: tagObject.name });
  if (!found) {
    docEntity.tags.push(tagObject);
  }

  moduleRoutes.routes.forEach((routeDef) => {
    buildSwaggerRequest(
      docEntity,
      routeEntity,
      tag,
      moduleRoutes.basePath,
      routeDef,
    );
  });
}

function convert(allModuleRoutes, docSkeleton, routeSkeleton) {
  const DOC_ROOT_TEMPLATE = {
    openapi: "3.0.1",
    info: {
      description: "API Docs",
      version: "1.0.0",
      title: "API Docs",
    },
    servers: [
      {
        url: "http://localhost/",
      },
    ],
    tags: [],
    paths: {},
    components: {
      schemas: {
        Error: {
          type: "object",
          required: ["code", "err"],
          properties: {
            code: {
              type: "string",
            },
            err: {
              type: "string",
            },
          },
        },
      },
    },
  };

  const ROUTE_DEF_TEMPLATE = {
    tags: [],
    summary: "",
    description: "",
    parameters: [],
    responses: {
      500: {
        description: "When Server takes a nap.",
        content: {
          "application/json": {
            schema: {
              $ref: "#/components/schemas/Error",
            },
          },
        },
      },
    },
  };

  const docEntity = _.assign({}, DOC_ROOT_TEMPLATE, docSkeleton);
  const routeEntity = _.assign({}, ROUTE_DEF_TEMPLATE, routeSkeleton);

  _.each(allModuleRoutes, (endpoint, endpointIndex) => {
    _.each(endpoint.routes, (route, routeIndex) => {
      const pathParameters = _.get(route, "validators.pathParameters");
      allModuleRoutes[endpointIndex].routes[routeIndex].parameters =
        allModuleRoutes[endpointIndex].routes[routeIndex].parameters || [];

      if (pathParameters) {
        _.each(
          _.get(pathParameters, "$_terms.keys"),
          ({ key, schema: { _flags: presence } }) => {
            allModuleRoutes[endpointIndex].routes[routeIndex].parameters.push({
              in: "path",
              name: key,
              schema: route.validators.pathParameters.extract(key),
              required: presence === "required",
            });
          },
        );
      }
      const queryStringParameters = _.get(
        route,
        "validators.queryStringParameters",
      );
      if (queryStringParameters) {
        _.each(
          _.get(queryStringParameters, "$_terms.keys"),
          ({ key, schema: { _flags: presence } }) => {
            allModuleRoutes[endpointIndex].routes[routeIndex].parameters.push({
              in: "path",
              name: key,
              schema: route.validators.queryStringParameters.extract(key),
              required: presence === "required",
            });
          },
        );
      }
    });
  });

  _.forEach(allModuleRoutes, (moduleRoutes) => {
    buildModuleRoutes(docEntity, routeEntity, moduleRoutes);
  });

  return docEntity;
}

module.exports = {
  convert,
};
