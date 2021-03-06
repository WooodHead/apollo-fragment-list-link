import { ApolloLink, Observable } from 'apollo-link';
import _get from 'lodash/get';
import _size from 'lodash/size';
import _castArray from 'lodash/castArray';

import gql from 'graphql-tag';

import {
  getOperationDefinition,
  getFragmentDefinition,
  getFragmentDefinitions,
  createFragmentMap,
} from 'apollo-utilities';

import {
  iterateOnTypename,
  createTransformerCacheIdValueNode,
  createCachableFragmentMap,
  createConnectionNode,
} from './utils';
import traverseSelections from './traverse';

function writeAllFragmentsToCache(
  cache,
  query,
  {
    result,
    context,
    variables,
    output = {},
    cachableFragmentMap = {},
    createLocalCacheKey,
    createConnectionTypename,
  } = {},
) {
  const document = cache.transformDocument(query);
  const operationDefinition = getOperationDefinition(document);
  const fragmentMap = createFragmentMap(getFragmentDefinitions(document));
  const selectionSet = operationDefinition.selectionSet;

  traverseSelections(selectionSet, result, {
    fragmentMap,
    cachableFragmentMap,
    variables,
    context,
    output,
  });

  const resolvedFragmentIds = Object.keys(output);
  const currentData = iterateOnTypename({
    resolvedFragmentIds,
    createLocalCacheKey,
    createConnectionTypename,
    getValueOnTypename: ({ localCacheKey, typename }) => {
      try {
        const { keys = { nodes: [] } } = cache.readQuery({
          query: gql`{
                keys:  ${localCacheKey} @client {
                    __cacheNodeId
                    totalCount
                    nodes
                }
                }`,
        });
        const transformer = createTransformerCacheIdValueNode(cache, typename);
        return (keys.nodes || []).map(transformer);
      } catch (error) {
        return [];
      }
    },
  });

  const data = iterateOnTypename({
    resolvedFragmentIds,
    createLocalCacheKey,
    createConnectionTypename,
    getValueOnTypename: ({ typename } = {}) => {
      const values = output[typename] || {};
      return Object.values(values);
    },
    initial: currentData,
  });

  // write data
  cache.writeData({ data });
}

/**
 *  Afterware for apollo-http-link
 */
class CacheQueryLink extends ApolloLink {
  constructor({
    cache,
    createCacheReadKey,
    createCacheRemoveKey,
    createConnectionTypename,
    fragmentTypeDefs = [],
  }) {
    super();
    this.cache = cache;
    //
    this.createCacheReadKey =
      createCacheReadKey || this._defaultCreateCacheReadKey;
    this.createCacheRemoveKey =
      createCacheRemoveKey || this._defaultCreateCacheRemoveKey;
    //
    this.createConnectionTypename =
      createConnectionTypename || this._defaultCreateConnectionTypename;
    //
    this.fragmentTypeDefs = fragmentTypeDefs;
  }

  _defaultCreateCacheReadKey = ({ typename }) => {
    return `all${typename}`;
  };

  _defaultCreateCacheRemoveKey = ({ typename }) => {
    return `remove${typename}`;
  };

  _defaultCreateConnectionTypename = ({ typename }) => {
    return `All${typename}Connection`;
  };

  _createRemoveMutationResolver = ({
    fragmentDoc,
    fragmentName,
    typename,
  } = {}) => (rootValue, args, context, info) => {
    const idSet = new Set(_castArray(_get(args, ['id'], [])));
    if (idSet.size < 1) {
      return false;
    }
    const cache = this.cache;
    const currentResults = this._typeResolver(
      {
        typename,
        fragment: fragmentDoc,
        name: fragmentName,
      },
      { rootValue, args, context, info },
    );
    if (
      !_get(currentResults, 'totalCount') ||
      _size(currentResults, 'nodes') < 1
    ) {
      return false;
    }
    const cacheKey = this.createCacheReadKey({ typename });

    const updatedNodes = _get(currentResults, ['nodes'], []).filter(
      (item = {}) => !idSet.has(item.id),
    );

    //  write data
    cache.writeData({
      data: {
        [cacheKey]: createConnectionNode({
          ...currentResults,
          nodes: updatedNodes,
          __typename: this.createConnectionTypename({ typename }),
        }),
      },
    });

    idSet.forEach(id => {
      //
      cache.writeFragment({
        id,
        fragment: fragmentDoc,
        data: null,
      });
      //
    });

    return true;
  };

  getFragmentByTypename = typename => {
    return (this.fragmentTypeDefs || []).find(item => {
      const fragmentDefinition = getFragmentDefinition(item);
      const fragmentTypename = fragmentDefinition.typeCondition.name.value;
      return typename === fragmentTypename;
    });
  };

  createArrayJoinConnection({ typename, joinItem = {} } = {}) {
    return (data = {}) => {
      const result = this.readNodesOnType(typename);
      const joinField = joinItem.field;
      const connectionField = _get(joinItem, ['connectionId'], 'id');
      /**
       * filtering on basis of parent node
       */
      const nodes = _get(result, ['nodes'], {}).filter(resultNode => {
        return _get(resultNode, [joinField]) === _get(data, [connectionField]);
      });
      return createConnectionNode({
        ...result,
        nodes,
      });
    };
  }

  /**
   *  create resolvers for ROOT_QUERY
   */
  createStateLinkQueryResolvers = () => {
    return this.fragmentTypeDefs.reduce((accum, fragmentTypeDef) => {
      const fragmentDefinition = getFragmentDefinition(fragmentTypeDef);
      const typename = _get(fragmentDefinition, [
        'typeCondition',
        'name',
        'value',
      ]);
      if (!typename) {
        return accum;
      }
      const readCacheKey = this.createCacheReadKey({ typename });

      return {
        ...accum,
        ...{
          [readCacheKey]: (rootValue, args, context, info) =>
            this._typeResolver(
              {
                typename,
                fragment: fragmentTypeDef,
                name: fragmentDefinition.name.value,
              },
              { rootValue, args, context, info },
            ),
        },
      };
    }, {});
  };

  /**
   * create resolvers for ROOT_MUTATIONS
   */
  createStateLinkMutationResolvers = () => {
    return (this.fragmentTypeDefs || []).reduce((accum, fragmentTypeDef) => {
      const fragmentDefinition = getFragmentDefinition(fragmentTypeDef);
      const typename = _get(fragmentDefinition, [
        'typeCondition',
        'name',
        'value',
      ]);
      const fragmentName = _get(fragmentDefinition, ['name', 'value']);
      if (!typename || !fragmentName) {
        return accum;
      }
      const localRemoveKey = this.createCacheRemoveKey({ typename });

      return {
        ...accum,
        ...{
          [localRemoveKey]: this._createRemoveMutationResolver({
            fragmentDoc: fragmentTypeDef,
            fragmentName,
            typename,
          }),
        },
      };
    }, {});
  };

  readNodesOnType = typename => {
    const fragment = this.getFragmentByTypename(typename);
    if (!fragment) {
      return null;
    }
    const fragmentDefinition = getFragmentDefinition(fragment);
    if (!fragmentDefinition) {
      return null;
    }
    return this._typeResolver({
      typename,
      fragment,
      name: fragmentDefinition.name.value,
    });
  };

  _typeResolver = ({ typename, fragment, name } = {}, { info } = {}) => {
    const localCacheKey = this.createCacheReadKey({ typename });
    //TODO ask for fragment
    const query = gql`
      query fetchResult{
        result: ${localCacheKey} @client {
            __cacheNodeId
            nodes {
               ...${name}
            }
            totalCount
        }
      }     
      ${fragment} 
    `;
    const cache = this.cache;
    let result = createConnectionNode({
      nodes: [],
      __typename: this.createConnectionTypename({ typename }),
    });

    try {
      const data = cache.readQuery({ query });
      if (data.result) {
        result = data.result;
      }
    } catch (ex) {}

    return result;
  };

  request(operation, forward) {
    return new Observable(observer => {
      let subscription;
      try {
        subscription = forward(operation).subscribe({
          next: result => {
            observer.next(result);

            const cachableFragmentMap = createCachableFragmentMap(
              this.fragmentTypeDefs,
            );

            writeAllFragmentsToCache(this.cache, operation.query, {
              result: result.data,
              cachableFragmentMap,
              variables: operation.variables,
              context: operation.getContext(),
              createLocalCacheKey: this.createCacheReadKey,
              createConnectionTypename: this.createConnectionTypename,
            });
          },
          error: networkError => {
            observer.error(networkError);
          },
          complete: () => {
            observer.complete.bind(observer)();
          },
        });
      } catch (error) {
        observer.error(error);
      }
      return () => {
        if (subscription) {
          subscription.unsubscribe();
        }
      };
    });
  }
}

export default CacheQueryLink;
