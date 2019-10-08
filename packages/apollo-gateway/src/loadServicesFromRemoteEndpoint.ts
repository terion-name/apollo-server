import {GraphQLRequest} from 'apollo-server-types';
import {Kind, parse, specifiedScalarTypes, visit} from 'graphql';
import {Headers, HeadersInit} from 'node-fetch';
import {GraphQLDataSource} from './datasources/types';
import {UpdateServiceDefinitions} from './';
import {ServiceDefinition} from '@apollo/federation';

export async function getServiceDefinitionsFromRemoteEndpoint({
  serviceList,
  headers = {},
  serviceSdlCache,
}: {
  serviceList: {
    name: string;
    url?: string;
    namespace?: string;
    dataSource: GraphQLDataSource;
  }[];
  headers?: HeadersInit;
  serviceSdlCache: Map<string, string>;
}): ReturnType<UpdateServiceDefinitions> {
  if (!serviceList || !serviceList.length) {
    throw new Error(
      'Tried to load services from remote endpoints but none provided',
    );
  }

  let isNewSchema = false;
  // for each service, fetch its introspection schema
  const serviceDefinitions: ServiceDefinition[] = (await Promise.all(
      serviceList.map(({name, url, namespace, dataSource}) => {
      if (!url) {
        throw new Error(`Tried to load schema from ${name} but no url found`);
      }

      const request: GraphQLRequest = {
        query: 'query GetServiceDefinition { _service { sdl } }',
        http: {
          url,
          method: 'POST',
          headers: new Headers(headers),
        },
      };

      return dataSource
        .process({ request, context: {} })
        .then(({ data, errors }) => {
          if (data && !errors) {
            const typeDefs = data._service.sdl as string;
            const previousDefinition = serviceSdlCache.get(name);
            // this lets us know if any downstream service has changed
            // and we need to recalculate the schema
            if (previousDefinition !== typeDefs) {
              isNewSchema = true;
            }
            serviceSdlCache.set(name, typeDefs);

            let serviceTypeDefs;
            if (namespace) {
              // FIXME namespacesMatcher is to check does a type refers to external one (e.g. is prefixed byy it's prefix)
              // FIXME This is not a bulletproof solution as not guarantees collisions, but as for now can't figure out nothing better
              const namespacesMatcher = serviceList.map(({namespace})=>namespace).join('|') + '.*';
              const typeNamePrefixer = (node: any) =>
                  !specifiedScalarTypes.find(({name}) => name === node.name.value) && !node.name.value.match(namespacesMatcher)
                      ? {...node, name: {...node.name, value: namespace + node.name.value}}
                      : undefined;
              serviceTypeDefs = visit(parse(typeDefs), {
                [Kind.NAMED_TYPE]: typeNamePrefixer,
                [Kind.OBJECT_TYPE_DEFINITION]: typeNamePrefixer,
                [Kind.SCALAR_TYPE_DEFINITION]: typeNamePrefixer
              });
            } else {
              serviceTypeDefs = parse(typeDefs);
            }

            return {
              name,
              url,
              typeDefs: serviceTypeDefs,
            };
          }

          // XXX handle local errors better for local development
          if (errors) {
            errors.forEach(console.error);
          }

          return false;
        })
        .catch(error => {
          console.warn(
            `Encountered error when loading ${name} at ${url}: ${error.message}`,
          );
          return false;
        });
    }),
  ).then(serviceDefinitions =>
    serviceDefinitions.filter(Boolean),
  )) as ServiceDefinition[];

  // XXX TS can't seem to infer that isNewSchema could be true
  return (isNewSchema as true | false)
    ? { serviceDefinitions, isNewSchema: true }
    : { isNewSchema: false };
}
