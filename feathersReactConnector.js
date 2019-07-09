import React, { useState, useEffect, useRef, useContext } from 'react';

export default function setupServiceConnector(feathersInstance, serviceName) {
    function paramsToString(params) {
        // May want to write a "canonical" way to stringify params,
        // e.g. alphabetize the object keys when stringifying
        return JSON.stringify(params);
    }
    function stringToParams(paramstr) {
        return JSON.parse(paramstr);
    }

    function cacheResult(response) {
        return {
            type: "result",
            response,
        };
    }
    function cacheError(error) {
        return {
            type: "error",
            error,
        };
    };
    /*
     * Idea: track number of subscribers to each parameter
     * Then expose a "useFeathers[Find|Get]" hook that
     * takes a query, increments its subscriber count, 
     * and returns whatever's stored in cache. 
     * That hook should use an effect with a cleanup
     * that decrements the subscriber count as well, 
     * which should allow the "used" feathers service
     * to delete the cached stuff. 
     */

    function incrCountAndReturnWhetherNew(subCounts, key) {
        if (!subCounts[key]) {
            subCounts[key] = 1;
            return true;
        } else {
            subCounts[key] = subCounts[key] + 1;
            return false;
        }
    }
    function decrCountAndReturnWhetherDelete(subCounts, key) {
        if (subCounts[key] === 1) {
            delete subCounts[key];
            return true;
        } else if (subCounts[key]) {
            subCounts[key] = subCounts[key] - 1;
            return false;
        } else {
            throw new Error(`useFeathersService: Tried to decrCount(${key}) not defined in subCounts`);
        }
    }

    function useFeathersService(service) {
        /*
         * **finds** is of the shape
         * {
         *  [stringified param]: cachePlaceholder | cacheResult | cacheError
         * }
         */
        const findSubCountsRef = useRef({});
        const findSubCounts = findSubCountsRef.current;
        const getSubCountsRef = useRef({});
        const getSubCounts = getSubCountsRef.current;

        const [finds, setFinds] = useState({});
        async function doFind(paramstr) {
            console.log(`find ${paramstr}`)
            const params = stringToParams(paramstr);
            try {
                const response = await service.find(params);
                setFinds(prevFinds => {
                    return {
                        ...prevFinds,
                        [paramstr]: cacheResult(response),
                    };
                });
            } catch (err) {
                console.log(`feathersReactConnector: Error ${err} when trying to find ${paramstr}`);
                setFinds(prevFinds => {
                    return {
                        ...prevFinds,
                        [paramstr]: cacheError(err),
                    };
                });
            }
        }

        function unsubFind(paramstr) {
            setFinds(prevFinds => {
                const newFinds = { ...prevFinds };
                delete newFinds[paramstr];
                return newFinds;
            })
        }
        function unsubGet(_id) {
            setGets(prevState => {
                const newState = { ...prevState };
                delete newState[_id];
                return newState;
            });
        }

        const [gets, setGets] = useState({});
        async function doGet(_id) {
            try {
                const response = await service.get(_id);
                setGets(prevGets => ({
                    ...prevGets,
                    [_id]: cacheResult(response),
                }));
            } catch (err) {
                setGets(prevGets => ({
                    ...prevGets,
                    [_id]: cacheError(err),
                }));
            }
        }

        function refetch() {
            for (let paramstr of Object.keys(finds)) {
                doFind(paramstr);
            }
            for (let _id of Object.keys(gets)) {
                doGet(_id);
            }
        }

        function augmentWithRefetch(mutatingFunction) {
            return async function (...args) {
                const result = await mutatingFunction(...args);
                refetch();
                return result;
            };
        }

        function useFind(params) {
            if (params == null) {
                params = {};
            }
            const paramstr = paramsToString(params);
            useEffect(() => {
                const newSub = incrCountAndReturnWhetherNew(findSubCounts, paramstr);
                if (newSub) {
                    doFind(paramstr);
                }
                return () => {
                    const wasLastSubscriber = decrCountAndReturnWhetherDelete(findSubCounts, paramstr);
                    if (wasLastSubscriber) {
                        unsubFind(paramstr);
                    }
                };
            }, [paramstr]);
            if (finds[paramstr] && finds[paramstr].response) {
                return finds[paramstr].response;
            } else {
                return {};
            }
        }
        // https://overreacted.io/a-complete-guide-to-useeffect/
        // cleanup of effect happens AFTER following paint, not before!
        // this helps resolve any "push-pop" issues with repeatedly 
        // unsubbing and then resubbing (forcing extra requests)

        function useGet(_id) {
            useEffect(() => {
                const newSub = incrCountAndReturnWhetherNew(getSubCounts, _id);
                if (newSub) {
                    doGet(_id);
                }
                return () => {
                    const wasLastSubscriber = decrCountAndReturnWhetherDelete(getSubCounts, _id);
                    if (wasLastSubscriber) {
                        unsubGet(_id);
                    }
                };
            }, [_id]);
            if (gets[_id] && gets[_id].response) {
                return gets[_id].response;
            } else {
                return {};
            }
        }

        return {
            create: augmentWithRefetch((...args) => service.create(...args)),
            update: augmentWithRefetch((...args) => service.update(...args)),
            patch: augmentWithRefetch((...args) => service.patch(...args)),
            remove: augmentWithRefetch((...args) => service.remove(...args)),
            useFind,
            useGet,
        };
    }


    const FeathersServiceContext =
        React.createContext({
            useFind: (_params) => ({}),
            useGet: (_id) => ({}),
            create: () => { },
            update: () => { },
            patch: () => { },
            remove: () => { },
        });

    function FeathersServiceProvider(props) {
        const { connector, children } = props;
        const {
            serviceName,
        } = connector;
        const service = useFeathersService(feathersInstance.service(serviceName));
        return (
            <FeathersServiceContext.Provider value={service}>
                {children}
            </FeathersServiceContext.Provider>
        );
    }

    function FindRenderer({ params, render }) {
        const service = useContext(FeathersServiceContext);
        const findResult = service.useFind(params);
        return render(findResult);
    }

    function GetRenderer({ id, render }) {
        const service = useContext(FeathersServiceContext);
        const getResult = service.useGet(id);
        return render(getResult);
    }


    function withService(Component) {
        return function (props) {
            return (
                <FeathersServiceContext.Consumer>
                    {value => {
                        const propsToPass = {
                            ...props,
                            [serviceName]: value,
                        };
                        return <Component {...propsToPass} />;
                    }}
                </FeathersServiceContext.Consumer>
            );
        }
    }
    withService.serviceName = serviceName;

    return {
        connector: withService,
        Provider: FeathersServiceProvider,
        FindRenderer,
        GetRenderer,
    };
}
