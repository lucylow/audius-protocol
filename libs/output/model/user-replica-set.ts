/* tslint:disable */
/* eslint-disable */
/**
 * API
 * No description provided (generated by Openapi Generator https://github.com/openapitools/openapi-generator)
 *
 * The version of the OpenAPI document: 1.0
 * 
 *
 * NOTE: This class is auto generated by OpenAPI Generator (https://openapi-generator.tech).
 * https://openapi-generator.tech
 * Do not edit the class manually.
 */



/**
 * 
 * @export
 * @interface UserReplicaSet
 */
export interface UserReplicaSet {
    /**
     * 
     * @type {number}
     * @memberof UserReplicaSet
     */
    'user_id': number;
    /**
     * 
     * @type {string}
     * @memberof UserReplicaSet
     */
    'wallet': string;
    /**
     * 
     * @type {string}
     * @memberof UserReplicaSet
     */
    'primary'?: string;
    /**
     * 
     * @type {string}
     * @memberof UserReplicaSet
     */
    'secondary1'?: string;
    /**
     * 
     * @type {string}
     * @memberof UserReplicaSet
     */
    'secondary2'?: string;
    /**
     * 
     * @type {number}
     * @memberof UserReplicaSet
     */
    'primarySpID'?: number;
    /**
     * 
     * @type {number}
     * @memberof UserReplicaSet
     */
    'secondary1SpID'?: number;
    /**
     * 
     * @type {number}
     * @memberof UserReplicaSet
     */
    'secondary2SpID'?: number;
}
