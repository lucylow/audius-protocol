import concurrent.futures
import logging
import time
from urllib.parse import urljoin, urlparse

import requests
from src.utils.eth_contracts_helpers import fetch_all_registered_content_nodes

logger = logging.getLogger(__name__)
NEW_BLOCK_TIMEOUT_SECONDS = 15


class IPFSClient:
    """Helper class for Audius Discovery Provider + IPFS interaction"""

    def __init__(
        self,
        eth_web3=None,
        shared_config=None,
        redis=None,
        eth_abi_values=None,
    ):
        # logger.warning("IPFSCLIENT | initializing")

        # Fetch list of registered content nodes to use during init.
        # During indexing, if ipfs fetch fails, _cnode_endpoints and user_replica_set are empty
        # it might fail to find content and throw an error. To prevent race conditions between
        # indexing starting and this getting populated, run this on init in the instance
        # in the celery worker
        if eth_web3 and shared_config and redis and eth_abi_values:
            self._cnode_endpoints = list(
                fetch_all_registered_content_nodes(
                    eth_web3, shared_config, redis, eth_abi_values
                )
            )
            logger.warning(
                f"IPFSCLIENT | fetch _cnode_endpoints on init got {self._cnode_endpoints}"
            )
        else:
            self._cnode_endpoints = []
            logger.warning("IPFSCLIENT | couldn't fetch _cnode_endpoints on init")

    def get_metadata_from_json(self, default_metadata_fields, resp_json):
        metadata = {}
        for parameter, value in default_metadata_fields.items():
            metadata[parameter] = (
                resp_json.get(parameter) if resp_json.get(parameter) != None else value
            )
        return metadata

    def force_clear_queue_and_stop_task_execution(self, executor):
        logger.info(
            "IPFSCLIENT | force_clear_queue_and_stop_task_execution - Clearing queue for executor..."
        )
        executor._threads.clear()
        concurrent.futures.thread._threads_queues.clear()

    # pylint: disable=broad-except
    def get_metadata(self, multihash, default_metadata_fields, user_replica_set=None):
        """Retrieve file from IPFS or gateway, validating metadata requirements prior to
        returning an object with no missing entries
        """
        logger.warning(f"IPFSCLIENT | get_metadata - {multihash}")
        api_metadata = default_metadata_fields
        retrieved_from_gateway = False
        retrieved_from_ipfs_node = False
        start_time = time.time()
        retrieved_metadata = False

        try:
            api_metadata = self.get_metadata_from_gateway(
                multihash, default_metadata_fields, user_replica_set
            )
            retrieved_metadata = api_metadata != default_metadata_fields
        except Exception as e:
            logger.error(
                f"IPFSCLIENT | ipfs_lib.py | \
                ERROR in get_metadata_from_gateway \
                generated {e}, multihash: {multihash}",
                exc_info=True,
            )

        # Raise error if metadata is not retrieved.
        # Ensure default values are not written into database.
        if not retrieved_metadata:
            logger.error(
                f"IPFSCLIENT | Retrieved metadata: {retrieved_metadata}. "
                f"retrieved from gateway : {retrieved_from_gateway}, "
                f"retrieved from local node : {retrieved_from_ipfs_node}"
            )
            logger.error(api_metadata)
            logger.error(default_metadata_fields)
            raise Exception(
                f"IPFSCLIENT | Failed to retrieve metadata. Using default values for {multihash}"
            )

        duration = time.time() - start_time
        logger.info(
            f"IPFSCLIENT | get_metadata ${multihash} {duration} seconds \
                | from ipfs:{retrieved_from_ipfs_node} |from gateway:{retrieved_from_gateway}"
        )

        return api_metadata

    # Retrieve a metadata object
    def load_metadata_url(self, url, max_timeout):
        # Skip URL if invalid
        validate_url = urlparse(url)
        if not validate_url.scheme:
            raise Exception(
                f"IPFSCLIENT | Invalid URL from provided gateway addr - {url}"
            )
        logger.info(f"IPFSCLIENT | load_metadata_url requesting metadata {url}")
        start_time = time.time()
        r = requests.get(url, timeout=max_timeout)
        logger.info(
            f"IPFSCLIENT | load_metadata_url to {url} finished in {time.time() - start_time} seconds, status: {r.status_code}, cache: {r.headers['CF-Cache-Status'] if hasattr(r.headers, 'CF-Cache-Status') else 'Not using cloudflare'}"
        )
        return r

    def query_ipfs_metadata_json(self, gateway_ipfs_urls, default_metadata_fields):
        start_time = time.time()
        with concurrent.futures.ThreadPoolExecutor() as executor:
            # Start the load operations and mark each future with its URL
            future_to_url = {
                executor.submit(
                    self.load_metadata_url, url, NEW_BLOCK_TIMEOUT_SECONDS
                ): url
                for url in gateway_ipfs_urls
            }
            for future in concurrent.futures.as_completed(future_to_url):
                url = future_to_url[future]
                try:
                    r = future.result()
                    if r.status_code != 200:
                        logger.warning(f"IPFSCLIENT | {url} - {r.status_code}")
                        raise Exception("Invalid status_code")
                    # Override with retrieved JSON value
                    formatted_json = self.get_metadata_from_json(
                        default_metadata_fields, r.json()
                    )
                    # Exit loop if dict is successfully retrieved
                    logger.info(
                        f"IPFSCLIENT | query_ipfs_metadata_json Retrieved from {url} took {time.time() - start_time} seconds"
                    )
                    self.force_clear_queue_and_stop_task_execution(executor)
                    return formatted_json

                except Exception as exc:
                    logger.error(f"IPFSClient | {url} generated an exception: {exc}")
        return None

    def get_metadata_from_gateway(
        self, multihash, default_metadata_fields, user_replica_set: str = None
    ):
        """Args:
        args.user_replica_set - comma-separated string of user's replica urls
        """

        # Default return initial metadata format
        gateway_metadata_json = default_metadata_fields
        logger.warning(
            f"IPFSCLIENT | get_metadata_from_gateway, {multihash} replica set: {user_replica_set}"
        )
        gateway_endpoints = self._cnode_endpoints

        # first attempt to first fetch metadata from user replica set, if provided & non-empty
        if user_replica_set and isinstance(user_replica_set, str):
            user_replicas = user_replica_set.split(",")
            try:
                query_urls = [f"{addr}/ipfs/{multihash}" for addr in user_replicas]
                data = self.query_ipfs_metadata_json(
                    query_urls, default_metadata_fields
                )
                if data is None:
                    raise Exception()
                return data
            except Exception:
                logger.error(
                    "IPFSCLIENT | get_metadata_from_gateway \
                        \nfailed to fetch metadata from user replica gateways"
                )

        logger.warning(
            f"IPFSCLIENT | get_metadata_from_gateway, \
                \ncombined addresses: {gateway_endpoints}, \
                \ncnode_endpoints: {self._cnode_endpoints}"
        )

        query_urls = [f"{addr}/ipfs/{multihash}" for addr in gateway_endpoints]
        data = self.query_ipfs_metadata_json(query_urls, default_metadata_fields)
        if data is None:
            raise Exception(
                f"IPFSCLIENT | Failed to retrieve CID {multihash} from gateway"
            )
        gateway_metadata_json = data
        return gateway_metadata_json

    def update_cnode_urls(self, cnode_endpoints):
        if len(cnode_endpoints):
            logger.info(
                f"IPFSCLIENT | update_cnode_urls with endpoints {cnode_endpoints}"
            )
            self._cnode_endpoints = cnode_endpoints


def construct_image_dir_gateway_url(address, CID):
    """Construct the gateway url for an image directory.

    Args:
        args.address - base url of gateway
        args.CID - CID of the image directory
    """
    if not address:
        return None

    return urljoin(address, f"/ipfs/{CID}/original.jpg")
